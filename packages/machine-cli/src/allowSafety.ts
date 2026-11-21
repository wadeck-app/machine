import { isTyped, type PolicyEntry } from '@wadeck-app/machine-core';

// "What a type cannot make safe" (typed-parameters.md): programs and options for which even a perfectly validated value does not make a typed
// entry safe. Signing such a typed entry is allowed (the owner decides) but is announced loudly before the passphrase prompt.

interface Rule {
  /** The program, lower-case, without directory or `.exe`, `.cmd`, `.bat`, `.ps1`. */
  program: string;
  /** The second word is one of these (absent: not tested). */
  subs?: string[];
  /** One of these words (or the flag before `=`) is present anywhere after the program. */
  options?: string[];
  /** Both the sub-command (any of `subs`) and one option (any of `options`) are needed. */
  both?: boolean;
  /** Any use of the program. */
  any?: boolean;
  why: string;
}

const SCRIPT = 'the clean value runs a script, a hook, a YAML file or a repository configuration';
const EXECUTES = 'an option or program that executes or writes';
const STORES = 'a daemon stores the value as a shell command and runs it later';
const RELAYS = 'it relays the command, widens rights, or pre-answers a security prompt';
const SECRET = 'a secret on a command line ends in the audit log';
const DAMAGE = 'the damage is the missing parameter';
const REWRITES = 'the tool rewrites its own arguments, so the validated value is not what runs: fixed templates only';

const RULES: Rule[] = [
  { program: 'npm', subs: ['run', 'test', 'install'], why: SCRIPT },
  { program: 'git', subs: ['pull'], why: SCRIPT },
  { program: 'git', options: ['-C'], why: SCRIPT },
  { program: 'docker', subs: ['compose'], options: ['-f'], both: true, why: SCRIPT },
  { program: 'git', options: ['-c', '--upload-pack'], why: EXECUTES },
  { program: 'find', options: ['-exec'], why: EXECUTES },
  { program: 'tar', options: ['--to-command'], why: EXECUTES },
  { program: 'zip', options: ['-TT'], why: EXECUTES },
  { program: 'curl', options: ['-o'], why: EXECUTES },
  { program: 'wget', options: ['-e'], why: EXECUTES },
  { program: 'ssh', options: ['-o'], why: EXECUTES },
  { program: 'ethtool', options: ['-f'], why: EXECUTES },
  { program: 'ip', subs: ['netns'], options: ['exec'], both: true, why: EXECUTES },
  { program: 'docker', subs: ['run', 'exec'], why: EXECUTES },
  { program: 'sudo', any: true, why: EXECUTES },
  { program: 'node', options: ['-e'], why: EXECUTES },
  { program: 'npx', any: true, why: EXECUTES },
  { program: 'orch', subs: ['add', 'edit', 'exec'], why: STORES },
  { program: 'queue', subs: ['sub'], options: ['--command'], both: true, why: STORES },
  { program: 'flow', subs: ['worker'], options: ['--command'], both: true, why: STORES },
  { program: 'agent-browser', subs: ['eval'], why: STORES },
  { program: 'machine', subs: ['run'], why: RELAYS },
  { program: 'machine', subs: ['admin', 'policy'], options: ['allow'], both: true, why: RELAYS },
  { program: 'machine', subs: ['join'], options: ['--yes-final-code'], both: true, why: RELAYS },
  { program: 'tool', options: ['--token', '--invite'], why: SECRET },
  { program: 'queue', subs: ['dlq'], options: ['clear'], both: true, why: DAMAGE },
  { program: 'task', subs: ['delete'], options: ['--all'], both: true, why: DAMAGE },
  { program: 'orch', subs: ['stop'], options: ['--kill-jobs'], both: true, why: DAMAGE },
  { program: 'orch', subs: ['exec'], why: REWRITES },
  { program: 'agent-browser', any: true, why: REWRITES },
];

const programName = (word: string): string => {
  const base = (word.split('/').at(-1) as string).split('\\').at(-1) as string;
  const lower = base.toLowerCase();
  return ['.exe', '.cmd', '.bat', '.ps1'].find((ext) => lower.endsWith(ext)) ? lower.slice(0, lower.lastIndexOf('.')) : lower;
};

/** The flag of a word: the part before `=`. */
const flagOf = (word: string): string => (word.includes('=') ? word.slice(0, word.indexOf('=')) : word);

/**
 * The warnings (each starts with `[warn]`) for a TYPED entry whose fixed words name one of the cases a type cannot make safe; none for an exact
 * entry. The program is the first word. `tool` stands for any program: `--token` and `--invite` are checked on every program, and
 * `credentials <user> <pass>` on every program too.
 */
export function unsafeTypedWarnings(entry: PolicyEntry): string[] {
  if (!isTyped(entry)) {
    return [];
  }
  const words = entry.template.split(' ').map((w) => (w.startsWith('<') ? '' : w.includes('=<') ? `${flagOf(w)}` : w));
  const [first = '', ...after] = words;
  const program = programName(first);
  const rest = after.filter((w) => w.length > 0);
  const found = new Set<string>();
  for (const rule of RULES) {
    if (rule.program !== program && !(rule.program === 'tool' && rule.options !== undefined)) {
      continue;
    }
    const subOk = rule.subs === undefined || rest.slice(0, 1).some((w) => (rule.subs as string[]).includes(w));
    const optionOk = rule.options === undefined || rest.some((w) => (rule.options as string[]).includes(flagOf(w)));
    const ok = rule.any === true ? true : rule.both === true ? subOk && optionOk : rule.subs !== undefined && rule.options === undefined ? subOk : optionOk;
    if (ok) {
      found.add(rule.why);
    }
  }
  // `credentials <user> <pass>`: a secret as a value, whatever the program.
  if (rest.includes('credentials')) {
    found.add(SECRET);
  }
  return [...found].map((why) => `[warn] this typed entry is on a case a type cannot make safe (${why}): a clean value does not make it safe. Prefer an exact entry (the whole command written by you), or do not allow it. It is signed anyway if you confirm\n`);
}
