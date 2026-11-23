// The ONE builder of the error answers of the module routes. `error` is the sentence (it names the cause and the fix); `message` carries the same
// sentence because the shell fetcher and the PIN dialog of the page display the top-level `message` of an error answer, never `error`.

export interface ErrorBody {
  status: number;
  kind: string;
  error: string;
  message: string;
}

export function errorBody(status: number, kind: string, error: string): ErrorBody {
  return { status, kind, error, message: error };
}
