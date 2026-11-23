// How long ago a request was asked, in the words of the module backend (requests.ts `ago`): the page recomputes it every second from the age it got at fetch time.

/** `seconds` is the age: under 5 s "now", then "N s ago", "N min ago", "N h ago", "N days ago". */
export function agoText(seconds: number): string {
  const abs = Math.max(0, Math.round(seconds));
  if (abs < 5) {
    return 'now';
  }
  if (abs < 120) {
    return `${abs} s ago`;
  }
  if (abs < 120 * 60) {
    return `${Math.round(abs / 60)} min ago`;
  }
  if (abs < 48 * 3600) {
    return `${Math.round(abs / 3600)} h ago`;
  }
  return `${Math.round(abs / 86_400)} days ago`;
}
