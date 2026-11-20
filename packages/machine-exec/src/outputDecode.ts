import { decodeCodePage } from './codePages.js';

export interface DecodedOutput {
  text: string;
  /** Not valid UTF-8 and not decodable with the machine's code page either: the text has replacement characters. */
  lossy: boolean;
  /** Set when the bytes were not UTF-8 and were decoded with this code page (for example `cp850`). */
  decodedFrom: string | undefined;
}

/**
 * Valid UTF-8 is kept as is. Otherwise, when the page of the machine is known and the bytes are valid in it, they are
 * decoded with it (only the output is converted; the command that ran is never touched, T-15). Anything else keeps the
 * old behaviour: lossy decoding and `lossy: true`, so that the caller warns.
 */
export async function decodeOutput(chunks: Buffer[], cut: boolean, oemCodePage: () => Promise<number | undefined>): Promise<DecodedOutput> {
  const bytes = Buffer.concat(chunks);
  try {
    // `stream` tolerates an incomplete character at the end: our own cap may have cut it, which is not an encoding problem.
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: cut }), lossy: false, decodedFrom: undefined };
  } catch {
    // Fall through to the code page.
  }
  let page: number | undefined;
  try {
    page = await oemCodePage();
  } catch {
    page = undefined;
  }
  const text = page === undefined ? undefined : decodeCodePage(bytes, page);
  if (text !== undefined) return { text, lossy: false, decodedFrom: `cp${page}` };
  return { text: bytes.toString('utf8'), lossy: true, decodedFrom: undefined };
}
