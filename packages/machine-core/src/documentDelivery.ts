import { MAX_DOCUMENT_BYTES, type SignedDocument } from './document.js';

// The `deliver-document` frame (decision 86): the admin machine hands the SAME sealed, admin-signed document it would put in the relay inbox
// straight to the addressee over the authenticated peer channel. The sender needs no authority: the document stands on the admin signature and is
// checked by the addressee exactly like an inbox document. Everything here is untrusted input from a peer: strict fixed fields, bounded. No I/O.

/** Frames per sender and minute; the excess is refused and audited by the receiver. */
export const MAX_DELIVERS_PER_MINUTE = 30;
/** The document cap of the relay inbox plus the frame fields. */
export const MAX_DELIVER_FRAME_BYTES = MAX_DOCUMENT_BYTES + 512;

export interface DeliverDocumentFrame {
  type: 'deliver-document';
  document: SignedDocument;
}

export type DeliverOutcome = 'installed' | 'already-installed';

export function buildDeliverDocument(document: SignedDocument): DeliverDocumentFrame {
  return { type: 'deliver-document', document };
}

type Fail = { ok: false; message: string };

export function parseDeliverDocument(message: unknown): { ok: true; document: unknown } | Fail {
  const fail = (m: string): Fail => ({ ok: false, message: `deliver-document: ${m}` });
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return fail('the frame must be an object');
  }
  const m: Record<string, unknown> = Object.fromEntries(Object.entries(message));
  for (const key of Object.keys(m)) {
    if (key !== 'type' && key !== 'document') {
      return fail(`unknown field "${key}"`);
    }
  }
  if (m['type'] !== 'deliver-document') {
    return fail('type must be "deliver-document"');
  }
  const document = m['document'];
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return fail('document must be a signed document ({ body, signature })');
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(message));
  } catch {
    return fail('the frame cannot be serialized');
  }
  if (size > MAX_DELIVER_FRAME_BYTES) {
    return fail(`the frame is larger than ${MAX_DELIVER_FRAME_BYTES} bytes (the document cap of the relay inbox is ${MAX_DOCUMENT_BYTES})`);
  }
  return { ok: true, document };
}

/** The acknowledgement of a delivery: only these two outcomes mean the addressee holds the document. */
export function parseDeliverAck(answer: unknown): { ok: true; id: string; outcome: DeliverOutcome } | Fail {
  const fail = (m: string): Fail => ({ ok: false, message: m });
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return fail('the answer is not an acknowledgement');
  }
  const a = answer as { type?: unknown; id?: unknown; outcome?: unknown };
  if (a.type !== 'deliver-ack' || typeof a.id !== 'string' || (a.outcome !== 'installed' && a.outcome !== 'already-installed')) {
    return fail('the answer is not a deliver-ack with outcome installed or already-installed');
  }
  return { ok: true, id: a.id.slice(0, 64), outcome: a.outcome };
}
