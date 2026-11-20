import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchCommand } from './startup.js';

// Test helper (not shipped logic). Tests NEVER run the real `orch`: they run this stub, a tiny node script in a temp
// folder that records its arguments and answers with scripted exit codes and outputs.

export interface OrchReply {
  code?: number;
  stdout?: string;
  stderr?: string;
  /** A file the stub writes before it answers (what a started daemon does: its port file). */
  writeFile?: { path: string; content: string };
}

export interface OrchStub {
  /** Inject this as the orch command. */
  orch: OrchCommand;
  dir: string;
  /** Scripted reply per first argument (ensure, remove, show). An unscripted call exits 99 and says so. */
  script: (replies: Record<string, OrchReply>) => void;
  /** Every call so far, as argument lists. */
  calls: () => string[][];
  /** One entry per call: whether the file named by the ORCH_STUB_WATCH variable existed while orch ran (to prove an order of events). */
  watched: () => ('exists' | 'missing')[];
}

const STUB_SOURCE = `const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.ORCH_STUB_WATCH) fs.appendFileSync(path.join(__dirname, 'watch.log'), (fs.existsSync(process.env.ORCH_STUB_WATCH) ? 'exists' : 'missing') + '\\n');
const script = JSON.parse(fs.readFileSync(path.join(__dirname, 'script.json'), 'utf8'));
const reply = script[process.argv[2]] || { code: 99, stderr: 'stub: no scripted reply for ' + process.argv[2] };
if (reply.writeFile) fs.writeFileSync(reply.writeFile.path, reply.writeFile.content);
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.code || 0);
`;

export function makeOrchStub(): OrchStub {
  const dir = mkdtempSync(join(tmpdir(), 'machine-orch-stub-'));
  const script = join(dir, 'orch-stub.cjs');
  writeFileSync(script, STUB_SOURCE);
  writeFileSync(join(dir, 'script.json'), '{}');
  appendFileSync(join(dir, 'calls.jsonl'), '');
  appendFileSync(join(dir, 'watch.log'), '');
  return {
    orch: { file: process.execPath, args: [script] },
    dir,
    script: (replies) => writeFileSync(join(dir, 'script.json'), JSON.stringify(replies)),
    calls: () =>
      readFileSync(join(dir, 'calls.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as string[]),
    watched: () =>
      readFileSync(join(dir, 'watch.log'), 'utf8')
        .split('\n')
        .filter((l) => l.length > 0) as ('exists' | 'missing')[],
  };
}
