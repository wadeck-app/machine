// Local-API check for the routes that sign or spend the relay token (none in the read-only slice).
//
// What it is NOT: authentication. Any local process can send this header, exactly as it can call any app-core module route
// (app-core only checks Host and Origin). It only refuses a request that did not come from this module's own page code,
// for instance a stray script or a form post. The read-only routes do not use it: the DSL `$sources` and the tab count of
// the shell cannot send custom headers, and those routes hand out nothing a local process could not read from the files.

export const MODULE_HEADER = 'x-machine-module';
export const MODULE_HEADER_VALUE = '1';

export interface Refusal {
  status: 403;
  error: string;
}

export function checkModuleHeader(req: unknown): Refusal | undefined {
  const headers = typeof req === 'object' && req !== null ? (req as { headers?: unknown }).headers : undefined;
  const value = typeof headers === 'object' && headers !== null ? (headers as Record<string, unknown>)[MODULE_HEADER] : undefined;
  if (value === MODULE_HEADER_VALUE) return undefined;
  return { status: 403, error: `this route needs the header ${MODULE_HEADER}: ${MODULE_HEADER_VALUE} (sent by the machine pages); a request without it is refused` };
}
