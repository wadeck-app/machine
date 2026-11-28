import { expect } from 'vitest';

// `0000000a11a5` is the reserved subject uuid of the network aliases (machine-core NETWORK_ALIASES_SUBJECT_UUID): made up, it is no machine.
// The privacy scan of the scenario material (seeds, scenario module): only made-up uuids, documentation addresses and no real name or secret. One definition, used by
// seeds.test.ts for the JSON seeds and by scenarios.test.ts for the scenario module and the sources it ships.

export function expectNoRealData(text: string): void {
  for (const uuid of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []) expect(uuid).toMatch(/^00000000-0000-4000-8000-(00000000000[1-3]|0000000a11a5)$/);
  for (const prefix of ['554e0e45', '51319efa', '14695579']) expect(text.toLowerCase()).not.toContain(prefix);
  for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) expect(ip).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/);
  for (const url of text.match(/https?:\/\/[^\s"'`)\\]+/g) ?? []) expect(url).toMatch(/^https:\/\/relay\.example\.net$/);
  expect(text).not.toMatch(/wadeck|infomaniak|poc-node|C:\\\\Users|\/Users\/|AppData/i);
  expect(text).not.toMatch(/Bearer|"token"|passphrase":/);
}
