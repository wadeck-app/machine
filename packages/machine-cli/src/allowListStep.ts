import { PromptTimeoutError } from './prompt.js';

// The "Allow list" step of `machine join` and `machine setup` (decision 70): who manages what the peers may run on THIS machine.
// The choice is local to this machine: mode admin is the default (nothing to set up), mode local needs no admin signature (decision 68).

export type AllowListMode = 'admin' | 'local';
export type AllowListHow = 'flag' | 'answer' | 'default-no-terminal' | 'default-unclear';

/** The question, in 2-3 lines of choices. */
export function allowListQuestion(selfName: string): string {
  return [
    'Who manages the allow list of this machine (the commands its peers may run here)?',
    `  [1] the admin (default): delegated, nothing to set up here; on the admin machine run \`machine admin allow ${selfName} -- <command>\``,
    '  [2] this machine itself: independent of any other machine; you choose a local passphrase now (`machine policy local enable`)',
    '',
  ].join('\n');
}

/** "1", "admin", "" (Enter) -> admin; "2", "local" -> local; anything else: undefined. */
export function parseAllowListAnswer(answer: string): AllowListMode | undefined {
  const a = answer.trim().toLowerCase();
  if (a === '' || a === '1' || a === 'admin') return 'admin';
  if (a === '2' || a === 'local') return 'local';
  return undefined;
}

const MAX_ATTEMPTS = 3;

export interface ChooseOptions {
  /** `--policy admin|local`: the question is not asked. */
  flag?: AllowListMode;
  selfName: string;
  /** A visible question; rejects without a terminal. */
  ask: (label: string) => Promise<string>;
  say: (text: string) => void;
  warn: (text: string) => void;
}

/**
 * Chooses the mode. Without a flag and without a terminal the default is `admin` AND it is said (never silent); a
 * question left unanswered in time (PromptTimeoutError) is not turned into an answer, it propagates.
 */
export async function chooseAllowList(o: ChooseOptions): Promise<{ mode: AllowListMode; how: AllowListHow }> {
  if (o.flag !== undefined) {
    o.say(`Allow list: ${o.flag === 'admin' ? 'managed by the admin' : 'managed by this machine'} (--policy ${o.flag}).\n`);
    return { mode: o.flag, how: 'flag' };
  }
  o.say(`${allowListQuestion(o.selfName)}`);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let answer: string;
    try {
      answer = await o.ask('Choice [1]: ');
    } catch (e) {
      if (e instanceof PromptTimeoutError) throw e;
      o.warn(`[warn] no terminal to ask who manages the allow list: the default applies, the admin manages it (nothing to set up here). Pass --policy local to manage it on this machine, or run \`machine policy local enable\` later\n`);
      return { mode: 'admin', how: 'default-no-terminal' };
    }
    const mode = parseAllowListAnswer(answer);
    if (mode !== undefined) return { mode, how: 'answer' };
    if (attempt < MAX_ATTEMPTS) o.warn(`[warn] "${answer.trim().slice(0, 40)}" is not a choice: type 1 (the admin), 2 (this machine) or press Enter for 1. Attempt ${attempt} of ${MAX_ATTEMPTS}\n`);
  }
  o.warn('[warn] no valid choice after 3 attempts: the default applies, the admin manages the allow list. Run `machine policy local enable` to manage it on this machine\n');
  return { mode: 'admin', how: 'default-unclear' };
}
