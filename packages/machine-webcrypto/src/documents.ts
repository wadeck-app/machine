import type { DocumentBody, DocumentInput, PolicyBody, PolicyEntry, RegistrationBody, RevocationBody, SignedDocument, SignedPolicy, SignedRegistration, SignedRevocation } from '@wadeck-app/machine-core';
import { decodeBase64urlAny, decodeBase64urlStrict, encodeBase64url } from './base64url.js';
import { canonicalize, type Json } from './canonical.js';
import { sha256 } from './keys.js';
import { sealTo } from './seal.js';
import { signBody } from './signed.js';
import { canonicalEntry, looksLikePlaceholder, parseTemplate, type Template } from './template.js';
import { TemplateError } from './typedParams.js';

// Signing of what the admin page produces: registrations, policies, revocation lists and the documents that carry them.
// The shape validators are copies of the pure validators of machine-core (registration.ts, policy.ts, revocation.ts,
// document.ts), kept message for message; documents.test.ts proves they accept and refuse the same bodies with the same messages.
// A body that no machine would accept is refused here, before it is signed.

export const REGISTRATION_DOMAIN = 'machine/registration/v1';
export const POLICY_DOMAIN = 'machine/policy/v1';
export const REVOCATION_DOMAIN = 'machine/revocation/v1';
// Envelope version 2: the payload of every document is sealed to the identity key of the addressee (decision 78). The version 1 domain
// (clear payload) is not built any more: machine-core only recognises it to refuse it.
export const DOCUMENT_DOMAIN_V2 = 'machine/document/v2';
export const DOCUMENT_KINDS = ['peer', 'policy', 'revocation', 'notice-recipients'] as const;
export const SHELLS = ['cmd', 'ps', 'bash', 'sh'] as const;
/** What the relay accepts for one document. */
export const MAX_DOCUMENT_BYTES = 16 * 1024;
/** The relay drops a document after 30 days: no document is built to live longer. */
export const DOCUMENT_RETENTION_SECONDS = 30 * 86_400;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const KEY_ID = /^[0-9a-f]{32}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const MAX_COMMAND = 2048;
const MAX_ENTRIES_PER_LIST = 200;
const MAX_PEERS = 64;
const REGISTRATION_FIELDS = ['v', 'uuid', 'name', 'identityPublicKey', 'serial', 'validFrom', 'validTo', 'adminKeyId'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonNegativeInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const posInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const isEpoch = posInt;

// ---- registration

export function assertRegistrationBody(value: unknown): asserts value is RegistrationBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('registration: the body must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!REGISTRATION_FIELDS.includes(key)) throw new Error(`registration: unknown field "${key}"`);
  }
  for (const key of REGISTRATION_FIELDS) {
    if (!(key in record)) throw new Error(`registration: missing field "${key}"`);
  }
  if (record.v !== 1) throw new Error(`registration: unsupported version ${String(record.v)} (this build reads version 1)`);
  if (typeof record.uuid !== 'string' || !UUID_V4.test(record.uuid)) throw new Error('registration: uuid must be a lowercase version 4 UUID');
  if (typeof record.name !== 'string' || !NAME.test(record.name)) {
    throw new Error('registration: name must be 1 to 32 characters (letters, digits, "_" or "-"), starting with a letter or a digit');
  }
  if (typeof record.identityPublicKey !== 'string') throw new Error('registration: identityPublicKey must be a string');
  try {
    decodeBase64urlStrict(record.identityPublicKey, 32, 'public key');
  } catch (e) {
    throw new Error(`registration: identityPublicKey is invalid: ${(e as Error).message}`);
  }
  if (!isNonNegativeInt(record.serial) || record.serial < 1) throw new Error('registration: serial must be a positive integer');
  if (!isNonNegativeInt(record.validFrom)) throw new Error('registration: validFrom must be epoch seconds (a non-negative integer)');
  if (!isNonNegativeInt(record.validTo) || record.validTo <= record.validFrom) {
    throw new Error('registration: validTo must be epoch seconds after validFrom');
  }
  if (typeof record.adminKeyId !== 'string' || !KEY_ID.test(record.adminKeyId)) throw new Error('registration: adminKeyId must be 32 lowercase hex characters');
}

export async function signRegistration(body: RegistrationBody, adminPrivateKey: CryptoKey): Promise<SignedRegistration> {
  assertRegistrationBody(body);
  return signBody(REGISTRATION_DOMAIN, body as unknown as Json, adminPrivateKey) as unknown as Promise<SignedRegistration>;
}

// ---- revocation

export function assertRevocationBody(value: unknown): asserts value is RevocationBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('revocation: the body must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['v', 'adminKeyId', 'issuedAt', 'entries'].includes(key)) throw new Error(`revocation: unknown field "${key}"`);
  }
  if (record.v !== 1) throw new Error(`revocation: unsupported version ${String(record.v)} (this build reads version 1)`);
  if (typeof record.adminKeyId !== 'string' || !KEY_ID.test(record.adminKeyId)) throw new Error('revocation: adminKeyId must be 32 lowercase hex characters');
  if (typeof record.issuedAt !== 'number' || !Number.isSafeInteger(record.issuedAt) || record.issuedAt < 0) throw new Error('revocation: issuedAt must be epoch seconds');
  if (!Array.isArray(record.entries)) throw new Error('revocation: entries must be a list');
  let previous: string | undefined;
  for (const entry of record.entries as unknown[]) {
    const e = entry as Record<string, unknown>;
    if (typeof e !== 'object' || e === null) throw new Error('revocation: every entry must be an object');
    for (const key of Object.keys(e)) {
      if (key !== 'uuid' && key !== 'serial') throw new Error(`revocation: unknown entry field "${key}"`);
    }
    if (typeof e.uuid !== 'string' || !UUID_V4.test(e.uuid)) throw new Error('revocation: entry uuid must be a lowercase version 4 UUID');
    if (typeof e.serial !== 'number' || !Number.isSafeInteger(e.serial) || e.serial < 1) throw new Error('revocation: entry serial must be a positive integer');
    if (previous !== undefined && e.uuid === previous) throw new Error(`revocation: duplicate entry for ${e.uuid}; keep only the highest serial`);
    if (previous !== undefined && e.uuid < previous) throw new Error('revocation: entries must be sorted by uuid');
    previous = e.uuid;
  }
}

export async function signRevocation(body: RevocationBody, adminPrivateKey: CryptoKey): Promise<SignedRevocation> {
  assertRevocationBody(body);
  return signBody(REVOCATION_DOMAIN, body as unknown as Json, adminPrivateKey) as unknown as Promise<SignedRevocation>;
}

// ---- policy

/** Why a command text cannot be allowed or launched, or undefined when it is acceptable. */
export function commandTextProblem(command: string): string | undefined {
  if (command.length === 0) return 'command must not be empty';
  if (command.length > MAX_COMMAND) return `command is longer than ${MAX_COMMAND} characters`;
  if (!PRINTABLE_ASCII.test(command)) return 'command must use printable ASCII only (no control or non-ASCII characters)';
  return undefined;
}

function assertCommand(command: unknown, where: string): asserts command is string {
  if (typeof command !== 'string') throw new Error(`policy: ${where} command must be a string`);
  const problem = commandTextProblem(command);
  if (problem) throw new Error(`policy: ${where} ${problem}`);
}

function assertEntries(list: unknown, where: string, version: number): void {
  if (!Array.isArray(list)) throw new Error(`policy: ${where} must be a list`);
  if (list.length > MAX_ENTRIES_PER_LIST) throw new Error(`policy: ${where} has more than ${MAX_ENTRIES_PER_LIST} entries`);
  const seen = new Set<string>();
  for (const raw of list as unknown[]) {
    const entry = raw as Record<string, unknown>;
    if (typeof entry !== 'object' || entry === null) throw new Error(`policy: every entry of ${where} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!['shell', 'command', 'template', 'limits'].includes(key)) {
        throw new Error(`policy: unknown field "${key}" in an entry of ${where}`);
      }
    }
    if (!(SHELLS as readonly unknown[]).includes(entry.shell)) throw new Error(`policy: shell must be one of ${SHELLS.join(', ')} (got ${String(entry.shell)})`);
    if (('command' in entry) === ('template' in entry)) {
      throw new Error(`policy: an entry of ${where} must hold exactly one of command (exact) or template (typed)`);
    }
    let canonical: string;
    let shown: string;
    if ('template' in entry) {
      if (version < 2) {
        throw new Error(`policy: ${where} holds a typed entry but the body is version ${version}: typed entries need version 2`);
      }
      const text = entry.template;
      if (typeof text !== 'string') {
        throw new Error(`policy: ${where} template must be a string`);
      }
      let parsed: Template;
      try {
        parsed = parseTemplate(text, entry.shell as PolicyEntry['shell']);
      } catch (e) {
        if (e instanceof TemplateError) {
          throw new Error(`policy: ${where} template "${text}" is refused: ${e.detail}`);
        }
        throw e;
      }
      canonical = canonicalEntry(entry.shell as PolicyEntry['shell'], { kind: 'typed', template: parsed });
      shown = text;
    } else {
      assertCommand(entry.command, where);
      // An exact entry that looks like a placeholder would be read differently by a reader that knows typed entries.
      if (looksLikePlaceholder(entry.command)) {
        throw new Error(`policy: ${where} exact command "${entry.command}" holds a <label:type> placeholder: write it as a typed entry (policy version 2) or remove the angle brackets`);
      }
      canonical = canonicalEntry(entry.shell as PolicyEntry['shell'], { kind: 'exact', command: entry.command });
      shown = entry.command;
    }
    if ('limits' in entry && entry.limits === undefined) throw new Error(`policy: limits of an entry of ${where} must be omitted, not undefined`);
    if (entry.limits !== undefined) {
      const limits = entry.limits as Record<string, unknown>;
      if (typeof limits !== 'object' || limits === null) throw new Error(`policy: limits of an entry of ${where} must be an object`);
      for (const key of Object.keys(limits)) {
        if (key !== 'maxCalls' && key !== 'expiresAt') throw new Error(`policy: unknown limit "${key}"`);
        if (limits[key] === undefined) throw new Error(`policy: limits.${key} must be omitted, not undefined`);
      }
      if (limits.maxCalls !== undefined && !posInt(limits.maxCalls)) throw new Error('policy: limits.maxCalls must be a positive integer');
      if (limits.expiresAt !== undefined && !posInt(limits.expiresAt)) throw new Error('policy: limits.expiresAt must be epoch seconds (a positive integer)');
    }
    if (seen.has(canonical)) {
      throw new Error(`policy: duplicate entry in ${where}: ${entry.shell as string} "${shown}" (labels and the order of enum members do not make an entry different)`);
    }
    seen.add(canonical);
  }
}

/** The highest policy body version this build reads (the same constants as machine-core policy.ts). */
const POLICY_MAX_VERSION = 2;
const UPDATE_HINT = 'run `machine cli update` on this machine';
/** The whole body as JSON: 200 entries of 2048 characters are about 400 KiB. */
const MAX_BODY_CHARS = 512 * 1024;

export interface PolicyReadOptions {
  /** The highest body version the reader knows (default POLICY_MAX_VERSION). A lower value simulates an older build. */
  readsUpTo?: number;
}

export function assertPolicyBody(value: unknown, options: PolicyReadOptions = {}): asserts value is PolicyBody {
  const readsUpTo = options.readsUpTo ?? POLICY_MAX_VERSION;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('policy: the body must be an object');
  const size = JSON.stringify(value).length;
  if (size > MAX_BODY_CHARS) {
    throw new Error(`policy: the body is ${size} characters, above the limit of ${MAX_BODY_CHARS} characters (512 KiB): remove entries or peer lists`);
  }
  const r = value as Record<string, unknown>;
  const fields = ['v', 'target', 'version', 'baseVersion', 'adminKeyId', 'issuedAt', 'notBefore', 'notAfter', 'defaults', 'peers'];
  for (const key of Object.keys(r)) {
    if (!fields.includes(key)) throw new Error(`policy: unknown field "${key}"`);
  }
  for (const key of fields) {
    if (!(key in r)) throw new Error(`policy: missing field "${key}"`);
  }
  if (r.v !== 1 && r.v !== 2) {
    throw new Error(`policy: unsupported version ${String(r.v)} (this build reads versions 1 to ${readsUpTo}): ${UPDATE_HINT}`);
  }
  if (r.v > readsUpTo) {
    throw new Error(`policy: unsupported version ${String(r.v)} (this reader knows versions 1 to ${readsUpTo}): ${UPDATE_HINT}, then apply the policy again`);
  }
  const bodyVersion = r.v;
  if (typeof r.target !== 'string' || !UUID_V4.test(r.target)) throw new Error('policy: target must be a lowercase version 4 UUID');
  if (typeof r.version !== 'number' || !Number.isSafeInteger(r.version) || r.version < 1) throw new Error('policy: version must be a positive integer');
  if (typeof r.baseVersion !== 'number' || !Number.isSafeInteger(r.baseVersion) || r.baseVersion < 0) throw new Error('policy: baseVersion must be a non-negative integer');
  if (r.version !== r.baseVersion + 1) throw new Error('policy: version must be baseVersion + 1');
  if (typeof r.adminKeyId !== 'string' || !KEY_ID.test(r.adminKeyId)) throw new Error('policy: adminKeyId must be 32 lowercase hex characters');
  for (const key of ['issuedAt', 'notBefore', 'notAfter']) {
    if (!posInt(r[key])) throw new Error(`policy: ${key} must be epoch seconds`);
  }
  if ((r.notAfter as number) <= (r.notBefore as number)) throw new Error('policy: notAfter must be after notBefore');
  assertEntries(r.defaults, 'defaults', bodyVersion);
  if (typeof r.peers !== 'object' || r.peers === null || Array.isArray(r.peers)) throw new Error('policy: peers must be an object keyed by peer UUID');
  const peerLists = Object.entries(r.peers);
  if (peerLists.length > MAX_PEERS) {
    throw new Error(`policy: more than ${MAX_PEERS} peers`);
  }
  for (const [id, list] of peerLists) {
    if (!UUID_V4.test(id)) throw new Error(`policy: peer key "${id}" is not a lowercase version 4 UUID`);
    assertEntries(list, `peers.${id}`, bodyVersion);
  }
}

export async function signPolicy(body: PolicyBody, adminPrivateKey: CryptoKey): Promise<SignedPolicy> {
  assertPolicyBody(body);
  return signBody(POLICY_DOMAIN, body as unknown as Json, adminPrivateKey) as unknown as Promise<SignedPolicy>;
}

// ---- documents distributed through the relay

/** The id of a document: the first 16 bytes of the SHA-256 of a stable string, base64url (22 characters). Same string, same id. */
export async function documentId(stableString: string): Promise<string> {
  return encodeBase64url((await sha256(new TextEncoder().encode(stableString))).subarray(0, 16));
}

/** The purpose a pair secret of a `peer` document is sealed for: the admin machine (sender), the addressee and the peer it is about. */
export function pairSecretDocumentContext(adminUuid: string | null, to: string, peerUuid: string): string {
  return `pair-secret:${adminUuid ?? 'none'}:${to}:${peerUuid}`;
}

function assertKeys(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) throw new Error(`${where}: unknown field "${key}"`);
  for (const key of allowed) if (!(key in o)) throw new Error(`${where}: missing field "${key}"`);
}

function isCanonicalBase64url(text: string, expectedBytes?: number): boolean {
  try {
    const bytes = decodeBase64urlAny(text, 'value');
    return expectedBytes === undefined || bytes.length === expectedBytes;
  } catch {
    return false;
  }
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || !isCanonicalBase64url(id, 16)) {
    throw new Error('document: id must be 22 characters of unpadded base64url (16 bytes), made by documentId()');
  }
}

/** The purpose the payload of a document is sealed for: the envelope version, the type, the addressee and the id. Equal to machine-core `documentSealContext`. */
export function documentSealContext(kind: string, to: string, id: string): string {
  return `document-payload:v2:${kind}:${to}:${id}`;
}

/** Shape of the body, payload excluded. Throws an Error naming the first problem. */
function assertEnvelope(body: unknown): void {
  if (!isObject(body)) throw new Error('document: the body must be an object');
  assertKeys(body, ['v', 'kind', 'to', 'id', 'issuedAt', 'expiresAt', 'payload'], 'document');
  if (body.v !== 2) {
    throw new Error(`document: unsupported envelope version ${String(body.v)} (this build reads version 2, sealed payloads): update machine on this machine, or on the admin machine if it is the older one (\`machine cli update\`)`);
  }
  if (typeof body.kind !== 'string' || !(DOCUMENT_KINDS as readonly string[]).includes(body.kind)) {
    throw new Error(`document: kind must be one of ${DOCUMENT_KINDS.join(', ')} (got ${JSON.stringify(body.kind)}): update machine if the sender is newer`);
  }
  if (typeof body.to !== 'string' || !UUID_V4.test(body.to)) throw new Error('document: to must be a lowercase version 4 UUID');
  assertId(body.id);
  if (!isEpoch(body.issuedAt)) throw new Error('document: issuedAt must be epoch seconds');
  if (!isEpoch(body.expiresAt) || body.expiresAt <= body.issuedAt) throw new Error('document: expiresAt must be epoch seconds after issuedAt');
  if (body.expiresAt - body.issuedAt > DOCUMENT_RETENTION_SECONDS) throw new Error('document: it must not live longer than the 30 days the relay keeps a document');
}

function assertPeerPayload(payload: unknown): void {
  if (!isObject(payload)) throw new Error('document: the payload of a peer document must be an object');
  assertKeys(payload, ['registration', 'sealedPairSecret', 'adminUuid'], 'document peer payload');
  if (!isObject(payload.registration) || !isObject(payload.registration.body) || typeof payload.registration.signature !== 'string') {
    throw new Error('document peer payload: registration must be a signed registration');
  }
  const sealed = payload.sealedPairSecret;
  if (typeof sealed !== 'string' || sealed.length === 0 || !isCanonicalBase64url(sealed)) {
    throw new Error('document peer payload: sealedPairSecret must be unpadded base64url text');
  }
  if (payload.adminUuid !== null && (typeof payload.adminUuid !== 'string' || !UUID_V4.test(payload.adminUuid))) {
    throw new Error('document peer payload: adminUuid must be a lowercase UUID, or null when the admin machine has no identity');
  }
}

function assertSignedPayload(payload: unknown, kind: 'policy' | 'revocation' | 'notice-recipients'): Record<string, unknown> {
  if (!isObject(payload)) throw new Error(`document: the payload of a ${kind} document must be an object`);
  assertKeys(payload, ['body', 'signature'], `document ${kind} payload`);
  if (!isObject(payload.body) || typeof payload.signature !== 'string') throw new Error(`document ${kind} payload: expected a signed ${kind} ({ body, signature })`);
  return payload.body;
}

function assertPayloadShape(kind: string, payload: unknown): void {
  if (kind === 'peer') assertPeerPayload(payload);
  else if (kind === 'policy') assertPolicyBody(assertSignedPayload(payload, 'policy'));
  else assertSignedPayload(payload, kind === 'notice-recipients' ? 'notice-recipients' : 'revocation');
}

/**
 * The inbox document of a policy signed by the page, sealed to the target (decision 78). Same rule as `distributePolicy` of machine-cli: the id comes
 * from the policy (`v2:` keeps it apart from the id of an older, clear document), it lives until the policy can no longer be applied (at most the 30 days
 * the relay keeps it). `now` only refuses an already expired one. `recipientIdentityPublicKey` is the key of the target from the registration the admin signed.
 */
export async function sealedPolicyDocument(signed: SignedPolicy, now: number, adminPrivateKey: CryptoKey, recipientIdentityPublicKey: string): Promise<SignedDocument> {
  const to = signed.body.target;
  const issuedAt = signed.body.issuedAt;
  const expiresAt = Math.min(issuedAt + DOCUMENT_RETENTION_SECONDS, signed.body.notAfter);
  if (expiresAt <= now) {
    throw new Error(`the policy could be applied until ${new Date(signed.body.notAfter * 1000).toISOString()}, which has passed: sign it again`);
  }
  return buildDocument(
    { kind: 'policy', to, id: await documentId(`v2:policy:${to}:${signed.body.version}:${signed.signature}`), issuedAt, expiresAt, payload: signed as never, recipientIdentityPublicKey },
    adminPrivateKey,
  );
}

/**
 * Admin side: validate the real payload, seal it to the addressee and sign the envelope. Refuses to sign what no machine would accept
 * (shape, lifetime, relay size limit). There is no plaintext mode: an input without the key of the addressee is an error.
 */
export async function buildDocument(input: DocumentInput, adminPrivateKey: CryptoKey): Promise<SignedDocument> {
  if (typeof input.recipientIdentityPublicKey !== 'string' || input.recipientIdentityPublicKey.length === 0) {
    throw new Error(
      'document: recipientIdentityPublicKey is required: every document is sealed to the identity key of its addressee because the relay must not read it, and there is no plaintext mode. Take the key from the registration of the addressee that this machine signed',
    );
  }
  assertEnvelope({ v: 2, kind: input.kind, to: input.to, id: input.id, issuedAt: input.issuedAt, expiresAt: input.expiresAt, payload: {} });
  assertPayloadShape(input.kind, input.payload);
  const sealed = await sealTo(input.recipientIdentityPublicKey, new TextEncoder().encode(canonicalize(input.payload as Json)), documentSealContext(input.kind, input.to, input.id));
  const body: DocumentBody = { v: 2, kind: input.kind, to: input.to, id: input.id, issuedAt: input.issuedAt, expiresAt: input.expiresAt, payload: { sealed } };
  const signed = (await signBody(DOCUMENT_DOMAIN_V2, body as unknown as Json, adminPrivateKey)) as unknown as SignedDocument;
  const size = new TextEncoder().encode(JSON.stringify(signed)).length;
  if (size > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `document ${input.id} is too large: ${size} bytes once sealed (the sealed form is a third bigger than the clear one), the relay accepts at most ${MAX_DOCUMENT_BYTES} bytes (16 KiB). A policy or a revocation list this big must be split or reduced`,
    );
  }
  return signed;
}
