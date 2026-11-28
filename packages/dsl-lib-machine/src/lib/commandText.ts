// The texts of the module (and of the daemon) write a command between backticks. A Notice takes plain text only, so the sentences that hold a command are split from the
// prose: the prose stays in the box, the commands are shown in monospace beside it (CommandNotice). A literal backtick is never shown.

/** `prose`: the sentences without a command, joined; `withCommands`: the sentences with one (or more) command between backticks, in order. */
export interface SplitCommandText {
  prose: string;
  withCommands: string[];
}

/** The sentences of `text`: a ".", "!" or "?" followed by a space ends one, unless it is inside a pair of backticks. */
function sentences(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    current += c;
    if (c === '`') {
      inCode = !inCode;
    } else if (!inCode && '.!?'.includes(c) && text[i + 1] === ' ') {
      out.push(current);
      current = '';
      i += 1;
    }
  }
  if (current !== '') {
    out.push(current);
  }
  return out;
}

const hasCommand = (sentence: string): boolean => /`[^`]+`/.test(sentence);

export function splitCommandText(text: string): SplitCommandText {
  const prose: string[] = [];
  const withCommands: string[] = [];
  for (const s of sentences(text)) {
    (hasCommand(s) ? withCommands : prose).push(s);
  }
  return { prose: prose.join(' '), withCommands };
}
