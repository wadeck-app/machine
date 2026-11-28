import { parseApprovalCode, recordApprovalCode } from './approvalCodes.js';
import { approveCandidacy, findApprovable, isCandidacyId, RelayRequestError, type SealedApprovalBody } from './candidacies.js';
import { callDaemon } from './daemonClient.js';
import { errorBody, type ErrorBody } from './errorBody.js';
import { checkModuleHeader } from './guard.js';

// Approve from the page, lot 4 (admin-ui.md, threat-model.md "Approve from the page"). The admin passphrase and the unlocked key exist ONLY in the browser:
// it signs the registrations, derives the pair secret and seals the approval. These routes carry what is already signed and sealed; they sign nothing, see
// no passphrase and no pair secret in clear. `sensitive` (app-core PIN: the first spends the relay admin token and makes this machine trust a machine) and
// they need the module header (the page component sends it; a DSL action could not).

interface ReplyLike {
  code(status: number): ReplyLike;
  send(body: unknown): unknown;
}

interface RouteContext {
  registerRoute(method: string, subPath: string, handler: (req: unknown, reply: ReplyLike) => unknown, options?: { effect: 'read' | 'write' | 'sensitive' }): void;
}

export interface ApproveDeps {
  configDir: () => string;
  /** The mapping of the module to an error answer (daemon unreachable, relay not configured, ...). */
  failureOf: (err: unknown) => ErrorBody;
}

const MAX_APPROVAL_BYTES = 16 * 1024;
const IMPORT_TIMEOUT_MS = 15_000;
// Delivery tries each machine directly first (a few seconds each when it is asleep) then the relay inbox.
const DISTRIBUTE_TIMEOUT_MS = 90_000;
// What the relay can ever store for one approval: a document is at most 16 KiB; far above what a network of a few machines needs, far below an abusive body.
const MAX_DISTRIBUTE_BYTES = 1024 * 1024;
const DISTRIBUTE_RULE = 'expected exactly {"candidateUuid": "<uuid>", "documents": [<signed inbox document>...], "noticeRecipients": <signed list, or null>}, nothing else: reload the page and approve again';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMPORT_FIELDS = ['registration', 'sealedPairSecret', 'adminUuid', 'candidateUuid', 'random'] as const;

/** The HTTP status of a refusal of the daemon commands `importCandidate` and `approveContext` (anything not listed is 502). */
const APPROVE_STATUS: Record<string, number> = {
  'bad-payload': 400,
  'no-admin-key': 409,
  'not-initialized': 409,
  'wrong-machine': 409,
  'key-changed': 409,
  'bad-registration': 422,
  'cannot-open': 422,
  refused: 409,
  // Lot 5 (approveDistribute).
  'bad-document': 422,
  'bad-notice-recipients': 422,
  'stale-notice-recipients': 409,
  'notice-recipients-invalid': 409,
  'not-imported': 409,
  'no-admin-token': 409,
};

const BODY_RULE = 'expected exactly {"approval": {"v": 2, "random": "...", "sealed": "..."}, "adminImport": <import for the admin machine, or null for the first machine approving itself>}, nothing else: reload the page and approve again';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

interface Parsed {
  approval: SealedApprovalBody;
  adminImport: Record<string, unknown> | null;
}

function parseBody(body: unknown): Parsed | string {
  if (!isObject(body) || Object.keys(body).some((k) => k !== 'approval' && k !== 'adminImport')) return BODY_RULE;
  if (!isObject(body['approval'])) return `"approval" is missing or not an object: ${BODY_RULE}`;
  if (!('adminImport' in body)) return `"adminImport" is missing (null when there is nothing to import): ${BODY_RULE}`;
  const approval = body['approval'];
  if (Object.keys(approval).some((k) => k !== 'v' && k !== 'random' && k !== 'sealed')) return `"approval" has a field other than v, random and sealed: ${BODY_RULE}`;
  if (approval['v'] !== 2) return `the approval has envelope version ${String(approval['v'])}, only version 2 (sealed) is accepted: update the page and approve again`;
  if (typeof approval['random'] !== 'string' || approval['random'].length === 0 || typeof approval['sealed'] !== 'string' || approval['sealed'].length === 0) return `"approval" needs a text "random" and a text "sealed": ${BODY_RULE}`;
  if (Buffer.byteLength(JSON.stringify(approval)) > MAX_APPROVAL_BYTES) return 'the approval is larger than 16 KiB: the relay refuses it, nothing was sent. It lists too many peers for one approval';
  const adminImport = body['adminImport'];
  if (adminImport !== null && !isObject(adminImport)) return `"adminImport" must be an object or null: ${BODY_RULE}`;
  return { approval: { v: 2, random: approval['random'], sealed: approval['sealed'] }, adminImport };
}

const kindOfStatus = (status: number): string => (status === 400 ? 'bad_request' : status === 404 ? 'not_found' : status === 409 ? 'not_pending' : 'relay_error');

function parseDistribute(body: unknown): { candidateUuid: string; documents: unknown[]; noticeRecipients: unknown } | string {
  if (!isObject(body) || Object.keys(body).length !== 3 || !('candidateUuid' in body) || !('documents' in body) || !('noticeRecipients' in body)) return DISTRIBUTE_RULE;
  const { candidateUuid, documents, noticeRecipients } = body;
  if (typeof candidateUuid !== 'string' || !UUID.test(candidateUuid)) return `"candidateUuid" is not the uuid of the approved machine: ${DISTRIBUTE_RULE}`;
  if (!Array.isArray(documents) || !documents.every(isObject)) return `"documents" must be a list of signed documents: ${DISTRIBUTE_RULE}`;
  if (noticeRecipients !== null && !isObject(noticeRecipients)) return `"noticeRecipients" must be a signed list or null: ${DISTRIBUTE_RULE}`;
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_DISTRIBUTE_BYTES) return 'the documents are too large (more than 1 MiB for one approval): nothing was delivered. Retry from the terminal with the command shown after an approval (`machine admin distribute <machine>`)';
  return { candidateUuid, documents, noticeRecipients };
}

export function registerApproveRoutes(ctx: RouteContext, deps: ApproveDeps): void {
  const SENSITIVE = { effect: 'sensitive' } as const;

  const daemon = async (command: string, payload: unknown, timeoutMs?: number): Promise<{ ok: true; answer: Record<string, unknown> } | { ok: false; failure: ErrorBody }> => {
    const answer = (await callDaemon(deps.configDir(), command, timeoutMs, payload)) as Record<string, unknown>;
    if (isObject(answer) && answer['ok'] === false) {
      const reason = typeof answer['reason'] === 'string' ? answer['reason'] : 'refused';
      const status = APPROVE_STATUS[reason] ?? 502;
      return { ok: false, failure: errorBody(status, reason, typeof answer['message'] === 'string' ? answer['message'] : `the daemon refused the ${command} command`) };
    }
    return { ok: true, answer };
  };

  ctx.registerRoute('GET', '/approve-context/:uuid', async (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    const uuid = isObject(req) && isObject(req['params']) ? req['params']['uuid'] : undefined;
    if (typeof uuid !== 'string' || !UUID.test(uuid)) return reply.code(400).send(errorBody(400, 'bad_request', 'expected the uuid of the candidacy in the path: /approve-context/<uuid>'));
    try {
      const out = await daemon('approveContext', { candidateUuid: uuid });
      return out.ok ? reply.code(200).send(out.answer) : reply.code(out.failure.status).send(out.failure);
    } catch (err) {
      const failure = deps.failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  }, SENSITIVE);

  // Lot 5: the page signed the peer documents and the list of notice recipients with the key it unlocked for the approval. They are sealed to their addressees and
  // signed: this route cannot read, change or sign them, it hands them to the daemon of the admin machine, which verifies them against the pinned key and the ids it
  // derives itself, then delivers them with the code of `machine admin distribute`.
  ctx.registerRoute('POST', '/approve-distribute', async (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    const parsed = parseDistribute(isObject(req) ? req['body'] : undefined);
    if (typeof parsed === 'string') return reply.code(400).send(errorBody(400, 'bad_request', parsed));
    try {
      const out = await daemon('approveDistribute', parsed, DISTRIBUTE_TIMEOUT_MS);
      return out.ok ? reply.code(200).send(out.answer) : reply.code(out.failure.status).send(out.failure);
    } catch (err) {
      const failure = deps.failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  }, SENSITIVE);

  // The page hands over the security code of the approval it just made, so that it can be read again once the dialog is closed (the relay purges the random of an
  // approved candidacy: the code cannot be recomputed later). A public value kept as a reminder, no signature and no secret: a plain write route.
  ctx.registerRoute('POST', '/approval-codes', async (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    const parsed = parseApprovalCode(isObject(req) ? req['body'] : undefined);
    if (typeof parsed === 'string') return reply.code(400).send(errorBody(400, 'bad_request', parsed));
    try {
      recordApprovalCode(deps.configDir(), parsed, Math.floor(Date.now() / 1000));
      return reply.code(200).send({ ok: true });
    } catch (err) {
      const failure = deps.failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  }, { effect: 'write' });

  ctx.registerRoute('POST', '/candidacies/:id/approve', async (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    const id = isObject(req) && isObject(req['params']) ? req['params']['id'] : undefined;
    if (typeof id !== 'string' || !isCandidacyId(id)) {
      return reply.code(400).send(errorBody(400, 'bad_request', 'the candidacy id must be 1 to 128 letters, digits, "-" or "_" (it is the id the relay listed): reload the page and approve the candidacy of the row again'));
    }
    const parsed = parseBody(isObject(req) ? req['body'] : undefined);
    if (typeof parsed === 'string') return reply.code(400).send(errorBody(400, 'bad_request', parsed));
    const { approval, adminImport } = parsed;

    let imported = false;
    try {
      // The relay is untrusted and the page may be stale: the candidacy is listed AGAIN, and everything below is checked against what it lists now.
      const view = await findApprovable(deps.configDir(), id, Math.floor(Date.now() / 1000));
      if (approval.random !== view.random) {
        return reply.code(409).send(errorBody(409, 'random_mismatch', 'the approval answers another candidacy than the one the relay lists now (its random differs): nothing was imported or approved. Reload the page and approve again'));
      }
      let importedAs: { uuid: string; name: string } | undefined;
      if (adminImport === null) {
        // Nothing to import is valid only for the first machine of a network approving itself; the daemon says whose machine this is.
        const context = await daemon('approveContext', { candidateUuid: view.uuid });
        if (!context.ok) return reply.code(context.failure.status).send(context.failure);
        const adminMachine = context.answer['adminMachine'];
        if (!isObject(adminMachine) || adminMachine['uuid'] !== view.uuid) {
          return reply.code(409).send(errorBody(409, 'import_required', 'this approval carries no import for the admin machine, and the candidate is not the admin machine itself: without the import this machine would not trust it. Nothing was approved; reload the page and approve again'));
        }
      } else {
        const fields = Object.fromEntries(IMPORT_FIELDS.map((k) => [k, adminImport[k]]));
        if (fields['candidateUuid'] !== view.uuid || fields['random'] !== view.random) {
          return reply.code(409).send(errorBody(409, 'import_mismatch', 'the import for the admin machine is not for the candidate and candidacy the relay lists now (uuid or random differ): nothing was imported or approved. Reload the page and approve again'));
        }
        // Only these fields go to the daemon, re-built here.
        const out = await daemon('importCandidate', fields, IMPORT_TIMEOUT_MS);
        if (!out.ok) return reply.code(out.failure.status).send(out.failure);
        imported = true;
        const candidate = out.answer['candidate'];
        importedAs = isObject(candidate) && typeof candidate['uuid'] === 'string' && typeof candidate['name'] === 'string' ? { uuid: candidate['uuid'], name: candidate['name'] } : undefined;
      }
      // Trust the candidate here BEFORE telling the relay: when the decision fails the extra entry is harmless, the opposite order could leave an enrolled machine this one does not know.
      try {
        await approveCandidacy(deps.configDir(), id, approval);
      } catch (e) {
        if (e instanceof RelayRequestError) {
          const tail = `. The candidate was NOT approved${imported ? '; its registration was already added to the peers of this machine (harmless, the candidate cannot use it before it is enrolled)' : ''}. Reload the page to see whether the candidacy is still pending`;
          const status = e.status === 0 ? 502 : e.status;
          return reply.code(status).send(errorBody(status, e.status === 0 ? 'relay_error' : kindOfStatus(e.status), `${e.message}${tail}`));
        }
        throw e;
      }
      return reply.code(200).send({ ok: true, id, message: `Candidacy ${id} approved: the candidate finishes on its next check, after the security codes are compared`, ...(importedAs === undefined ? {} : { imported: importedAs }) });
    } catch (err) {
      if (err instanceof RelayRequestError) {
        const status = err.status === 0 || err.status === 401 || err.status === 403 ? 502 : err.status;
        const kind = err.status === 0 || err.status === 401 || err.status === 403 ? 'relay_error' : kindOfStatus(err.status);
        return reply.code(status).send(errorBody(status, kind, err.message));
      }
      const failure = deps.failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  }, SENSITIVE);
}
