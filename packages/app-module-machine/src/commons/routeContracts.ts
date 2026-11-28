// The wire contracts of the Candidacies routes (request and answer of every route the page calls), BROWSER-SAFE: no import at all, so the mock of the page
// (dsl-scenarios) and the page can use them without pulling a Node module. The real types live in Node-only modules of the backend, so they are re-declared here;
// `src/scenarios-draft/routeContracts.test.ts` proves at compile time (typecheck) that each one is assignable to / from the real type, so they cannot drift.
//
// Not a route: `GET /approval-codes` does not exist in the backend. The kept security codes ride `GET /candidacies` (`approvals`); only `POST /approval-codes` exists.

/** The body of every error answer (backend `errorBody.ts`). `message` repeats `error`: the shell shows `message`. */
export interface ErrorBody {
  status: number;
  kind: string;
  error: string;
  message: string;
}

/** What the relay list proves of one candidacy, after the backend review (backend `candidacies.ts` CandidacyListView). */
export interface CandidacyView {
  id: string;
  name: string;
  hostname: string;
  observedIp: string;
  uuid: string | undefined;
  /** Epoch seconds. */
  createdAt: number | undefined;
  expiresAt: number | undefined;
  relayStatus: string | undefined;
  ageSeconds: number | undefined;
  uuidBound: boolean | undefined;
  boundTokenLabel: string | undefined;
  boundToCandidateToken: boolean | undefined;
  rebind: boolean;
  bindingNote: string | undefined;
  /** Recomputed by the backend from the key and random; undefined when it cannot be. */
  code: string | undefined;
  identityPublicKey: string | undefined;
  random: string | undefined;
  problems: string[];
}

/** A row of `GET /candidacies` (backend `index.ts` `candidacyRow`: not exported, so the assignability is checked on the route output, see the test). */
export interface CandidacyRow extends CandidacyView {
  ageText: string;
  bindingText: string;
  statusText: string;
  canDecide: boolean;
  canApprove: boolean;
}

export type TimelineStatus = 'done' | 'current' | 'todo';

export interface TimelineStepRow {
  id: string;
  title: string;
  status: TimelineStatus;
  info: string;
  description?: string;
}

/** The security code of an approval made from the page, kept to be read again (backend `approvalCodes.ts`). */
export interface ApprovalReminder {
  uuid: string;
  name: string;
  code: string;
  ageText: string;
}

export interface CandidaciesAnswer {
  candidacies: CandidacyRow[];
  count: number;
  timeline: TimelineStepRow[];
  timelineNote: string;
  approvals: ApprovalReminder[];
  approvalsProblem: string;
}

/** `GET /admin-key`: the encrypted key file as text (JSON of an `AdminKeyEnvelope`), for the page to unlock. */
export interface AdminKeyAnswer {
  file: string;
}

export interface RegistrationBodyWire {
  v: 1;
  uuid: string;
  name: string;
  identityPublicKey: string;
  serial: number;
  validFrom: number;
  validTo: number;
  adminKeyId: string;
}

export interface SignedRegistrationWire {
  body: RegistrationBodyWire;
  signature: string;
}

/** A signed document the page only forwards (the notice recipients list, an inbox document): opaque here. */
export interface SignedDocumentWire {
  body: object;
  signature: string;
}

/** `GET /approve-context/:uuid` (daemon command `approveContext`). */
export interface ApproveContextAnswer {
  ok: true;
  adminMachine: { uuid: string; name: string; identityPublicKey: string };
  adminPublicKey: string;
  adminKeyId: string;
  candidate: { trusted: boolean; name?: string; identityPublicKey?: string; revokedSerial?: number };
  others: SignedRegistrationWire[];
  noticeRecipients: SignedDocumentWire | null;
}

/** `POST /candidacies/:id/approve`: what the page signed and sealed (backend `candidacyApprove.ts`). */
export interface ApproveRequest {
  approval: { v: 2; random: string; sealed: string };
  adminImport: Record<string, unknown> | null;
}

export interface ApproveAnswer {
  ok: true;
  id: string;
  message: string;
  imported?: { uuid: string; name: string };
}

export interface RejectAnswer {
  ok: true;
  id: string;
  message: string;
}

/** `POST /approve-distribute`. */
export interface DistributeRequest {
  candidateUuid: string;
  documents: Array<Record<string, unknown>>;
  noticeRecipients: Record<string, unknown> | null;
}

export type DeliveryState = 'delivered' | 'inbox' | 'failed';

export interface DeliveryMachineWire {
  uuid: string;
  name: string;
  state: DeliveryState;
  code: string;
  reason: string;
  next: string;
}

/** The answer of the daemon command `approveDistribute` when it ran (machine-cli `approveDistribute.ts`). `report` is the raw CLI report: the page does not read it. */
export interface DistributeAnswer {
  ok: true;
  subject: { uuid: string; name: string };
  failed: boolean;
  report: object;
  text: { out: string; err: string };
  machines: DeliveryMachineWire[];
  retry: string;
}

/** `POST /approval-codes`: the page hands over the code it just showed. */
export interface ApprovalCodeRequest {
  uuid: string;
  name: string;
  code: string;
}

export interface OkAnswer {
  ok: true;
}

/** What a route answers: a status and a body (the success body, or an `ErrorBody` for any 4xx or 5xx). */
export interface RouteAnswer<T> {
  status: number;
  body: T | ErrorBody;
}

/** Every route of the Candidacies page: its request (path parameter, body) and its success answer. */
export interface RouteContracts {
  'GET /candidacies': { request: Record<string, never>; answer: CandidaciesAnswer };
  'GET /admin-key': { request: Record<string, never>; answer: AdminKeyAnswer };
  'GET /approve-context/:uuid': { request: { uuid: string }; answer: ApproveContextAnswer };
  'POST /candidacies/:id/approve': { request: { id: string; body: ApproveRequest }; answer: ApproveAnswer };
  'POST /candidacies/:id/reject': { request: { id: string }; answer: RejectAnswer };
  'POST /approve-distribute': { request: { body: DistributeRequest }; answer: DistributeAnswer };
  'POST /approval-codes': { request: { body: ApprovalCodeRequest }; answer: OkAnswer };
}

export type RouteKey = keyof RouteContracts;
