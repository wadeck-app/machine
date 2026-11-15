// Times shown to a person: local clock time with a relative hint ("in 12 min (14:32)"). The machine-readable output (--json) keeps
// its own numbers and ISO strings; UTC never appears in the human text.

const pad = (n: number): string => String(n).padStart(2, '0');

function relative(deltaSeconds: number): string {
  const abs = Math.abs(deltaSeconds);
  if (abs < 5) return 'now';
  let amount: string;
  if (abs < 120) amount = `${abs} s`;
  else if (abs < 120 * 60) amount = `${Math.round(abs / 60)} min`;
  else if (abs < 48 * 3600) amount = `${Math.round(abs / 3600)} h`;
  else amount = `${Math.round(abs / 86_400)} days`;
  return deltaSeconds > 0 ? `in ${amount}` : `${amount} ago`;
}

/** Local clock of `at`: "14:32" on the day of `now`, "2026-11-16 14:32" on another day. */
export function clockText(at: number, now: number): string {
  const d = new Date(at * 1000);
  const n = new Date(now * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** "expires in 12 min (14:32)" or, once it passed, "expired 3 min ago (14:17)". */
export function expiryText(at: number, now: number): string {
  return `${at > now ? 'expires' : 'expired'} ${whenText(at, now)}`;
}

/** "in 12 min (14:32)","3 min ago (14:17)", "3 days ago (2026-11-12 14:20)". Both arguments are epoch seconds. */
export function whenText(at: number, now: number): string {
  return `${relativeText(at, now)} (${clockText(at, now)})`;
}

/** "in 12 min", "3 min ago", "now". */
export function relativeText(at: number, now: number): string {
  if (!Number.isFinite(at) || !Number.isFinite(now)) throw new Error(`whenText needs epoch seconds, got ${String(at)} and ${String(now)}`);
  return relative(Math.round(at - now));
}
