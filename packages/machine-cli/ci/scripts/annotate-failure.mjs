// Prints a GitHub Actions error annotation made of the end of a log, so that the reason of a failed step is on the summary
// page of the run (the job logs are not readable without admin rights).
// usage: annotate-failure.mjs <title> <log file>
// Always exits 0 once it printed: it runs in an `if: failure()` step and must not hide the failure it reports.
import { existsSync, readFileSync } from 'node:fs';

const LAST_LINES = 60;
const MAX_CHARS = 1400;
const MAX_FAILING_LINES = 10;
const MAX_HEAD_CHARS = 1500;
// Terminal colors (vitest prints them in CI) break the matching and are noise in an annotation.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
// vitest FAIL / AssertionError / "Error:" lines, a "failed" summary, and the x / cross markers of a failed test.
const FAILURE_LINE = /\bFAIL\b|AssertionError|\bError:|\bfailed\b|^\s*[x✗✖×]\s/;

const [title, file] = process.argv.slice(2);
if (title === undefined || file === undefined) {
  process.stderr.write('usage: annotate-failure.mjs <title> <log file>\n');
  process.exit(2);
}

// Escaping of the workflow commands: the data and the property differ only by `:` and `,`.
const escapeData = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

function messageOf() {
  if (!existsSync(file)) {
    return `no log file at ${file}: the failure is in an earlier step, or the step did not write its log`;
  }
  const text = readFileSync(file, 'utf8').replace(ANSI, '').replace(/\s+$/, '');
  if (text === '') {
    return `the log is empty (${file}): the step failed without printing anything`;
  }
  const all = text.split('\n');
  let tail = all.slice(-LAST_LINES).join('\n');
  if (tail.length > MAX_CHARS) {
    tail = `(truncated) ${tail.slice(-MAX_CHARS)}`;
  }
  // The end of a log often shows later, passing steps: the first failure is what explains the run.
  const tailStart = all.length - LAST_LINES;
  const failing = all
    .map((line, index) => ({ line: line.replace(ANSI, '').replace(/\s+$/, ''), index }))
    .filter(({ line, index }) => index < tailStart && FAILURE_LINE.test(line))
    .slice(0, MAX_FAILING_LINES)
    .map(({ line }) => line.trim().slice(0, 300));
  if (failing.length === 0) return tail;
  let head = failing.join('\n');
  if (head.length > MAX_HEAD_CHARS) head = `${head.slice(0, MAX_HEAD_CHARS)} (truncated)`;
  return `first failing lines:\n${head}\n--- end of the log ---\n${tail}`;
}

process.stdout.write(`::error title=${escapeProperty(title)}::${escapeData(messageOf())}\n`);
