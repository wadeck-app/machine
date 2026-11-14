#!/usr/bin/env node
import { runCli } from './cli.js';

runCli(process.argv.slice(2), { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) }).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`[fail] unexpected error: ${(e as Error).stack ?? String(e)}\n`);
    process.exitCode = 1;
  },
);
