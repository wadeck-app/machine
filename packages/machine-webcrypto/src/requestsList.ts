import { encodeBase64url } from './base64url.js';
import type { Json } from './canonical.js';
import { signBody, type SignedBody } from './signed.js';

// The `requests-list` request of the Requests page: the admin machine asks a peer for its held and refused requests. Read-only, signed with the ADMIN key
// in the browser (the module backend and the daemon only forward it). Same document as machine-core requestsList.ts (domain, fields, lifetime), checked
// against its verifier in requestsList.test.ts.

export const REQUESTS_LIST_DOMAIN = 'machine/requests-list/v1';
/** Groups a request may ask for (machine-core REQUESTS_LIST_MAX_GROUPS). */
export const REQUESTS_LIST_MAX_LIMIT = 100;
/** The peer accepts at most 60 seconds between issue and expiry. */
export const REQUESTS_LIST_LIFETIME_SECONDS = 30;

export interface RequestsListBody {
  v: 1;
  id: string;
  nonce: string;
  /** The machine that sends the frame: the one this page runs on (the peer checks it against the connection). */
  source: string;
  target: string;
  limit: number;
  issuedAt: number;
  expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newRequestsListBody(input: { source: string; target: string; limit: number; now: number }): RequestsListBody {
  if (!UUID.test(input.source)) throw new Error('requests-list: source must be the uuid of this machine');
  if (!UUID.test(input.target)) throw new Error('requests-list: target must be the uuid of the machine to ask');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > REQUESTS_LIST_MAX_LIMIT) throw new Error(`requests-list: limit must be a whole number from 1 to ${REQUESTS_LIST_MAX_LIMIT}`);
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  return { v: 1, id: crypto.randomUUID(), nonce: encodeBase64url(nonce), source: input.source, target: input.target, limit: input.limit, issuedAt: input.now, expiresAt: input.now + REQUESTS_LIST_LIFETIME_SECONDS };
}

export function signRequestsList(body: RequestsListBody, adminPrivateKey: CryptoKey): Promise<SignedBody<RequestsListBody>> {
  return signBody(REQUESTS_LIST_DOMAIN, body as unknown as Json, adminPrivateKey) as unknown as Promise<SignedBody<RequestsListBody>>;
}
