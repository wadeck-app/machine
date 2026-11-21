// Test fixture of runLogStore.test.ts: one process of "two machine run at once". Usage: <configDir> <tag> <count>
import { buildRunLogLine } from '@wadeck-app/machine-core';
import { appendRunLog } from './runLogStore.js';

const [configDir, tag, count] = process.argv.slice(2);
if (configDir === undefined || tag === undefined || count === undefined) {
  throw new Error('usage: runLogChild.fixture.ts <configDir> <tag> <count>');
}
const machine = { name: 'laptop', uuid: '11111111-1111-4111-8111-111111111111' };
for (let n = 0; n < Number(count); n++) {
  const line = buildRunLogLine({
    now: Date.now(),
    runId: `${tag}-${n}`,
    from: machine,
    to: { name: 'desk', uuid: '22222222-2222-4222-8222-222222222222' },
    shell: 'sh',
    command: `echo ${tag} ${n} ${'x'.repeat(300)}`,
    waitMode: 'default',
    onRefusal: 'wait',
    waitSeconds: 600,
    waitedSeconds: 0,
    outcome: { outcome: 'ran', exitCode: 0 },
    durationMs: 1,
  });
  const result = appendRunLog(configDir, line);
  if (!result.written) {
    throw new Error(result.warnings.join('; '));
  }
}
