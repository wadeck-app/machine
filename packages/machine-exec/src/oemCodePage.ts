import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { parseOemCodePage } from './codePages.js';
import { scrubEnv, windowsSystemRoot } from './launch.js';

const KEY = win32.join('HKLM', 'SYSTEM', 'CurrentControlSet', 'Control', 'Nls', 'CodePage');
let cached: number | undefined;

/**
 * The OEM code page of this Windows machine (what cmd, ipconfig and PowerShell write by default), read once from the
 * registry with `reg.exe query ... /v OEMCP` and cached. Why not `chcp`: it prints the page of the current console
 * (whatever the daemon's console was switched to), in a localized sentence, and is a cmd built-in; reg.exe prints one
 * language-neutral line and does not depend on a console. Undefined (never an error) when it cannot be read: not Windows,
 * no SystemRoot, reg.exe missing or failing, unparsable output. A failure is not cached, the next call tries again.
 */
export async function detectOemCodePage(env: Record<string, string | undefined>): Promise<number | undefined> {
  if (process.platform !== 'win32') return undefined;
  const root = windowsSystemRoot(env);
  if (!root) return undefined;
  if (cached !== undefined) return cached;
  const page = await new Promise<number | undefined>((resolve) => {
    let out = '';
    let settled = false;
    const done = (value: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // No shell: the file is the absolute path of reg.exe and the arguments are separate.
    const child = spawn(win32.join(root, 'System32', 'reg.exe'), ['query', KEY, '/v', 'OEMCP'], { env: scrubEnv(env, 'win32'), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      done(undefined);
    }, 10_000);
    child.stdout.on('data', (c: Buffer) => (out += c.toString('latin1')));
    child.on('error', () => done(undefined));
    child.on('close', (code) => done(code === 0 ? parseOemCodePage(out) : undefined));
  });
  if (page !== undefined) cached = page;
  return page;
}
