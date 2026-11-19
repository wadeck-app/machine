import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectionsFile } from './connectionsStore.js';
import { readMachine } from './identity.js';
import { cli, provision } from './testing.js';
import type { WakeSender } from './wakeSender.js';
import { wakeAuditFile } from './wakeAudit.js';

// `machine peer connect` and `machine peer wake` (decision 62): settings, flags over file, validation, the failing cases. A = "desktop" (admin, caller), B = "laptop" (the peer).

let root: string;
let a: string;
let b: string;
let laptop: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-cliwake-'));
  a = join(root, 'a');
  b = join(root, 'b');
  await provision(root, a, b, []);
  laptop = readMachine(b).uuid;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const connect = (args: string[]) => cli(a, ['peer', 'connect', ...args]);
const fileOf = (): { v: number; peers: Record<string, Record<string, unknown>> } => JSON.parse(readFileSync(connectionsFile(a), 'utf8')) as never;

describe('machine peer connect <machine> --show', () => {
  it('a peer with no settings: says it is direct with the relay addresses and how to set something', async () => {
    const r = await connect(['laptop', '--show']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toBe(`laptop (${laptop}): no connection settings: direct, the address comes from the relay record. Pin an address or set up Wake-on-LAN with: machine peer connect laptop --address <host:port> --wake-mac <aa:bb:cc:dd:ee:ff>\n`);
    expect(existsSync(connectionsFile(a))).toBe(false);
  });

  it('prints the effective values with (default) marks for what nobody set, and the flag that changes each', async () => {
    expect((await connect(['laptop', '--address', '192.168.1.40:47921', '--wake-mac', 'AA-BB-CC-DD-EE-01', '--wake-probe', '8'])).code).toBe(0);
    const r = await connect(['laptop', '--show']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        `laptop (${laptop})  ${connectionsFile(a)}`,
        '  type              ping-if-not-reachable-magic-packet',
        '  addresses         192.168.1.40:47921 (pinned: the relay record is not used)',
        '  wake mac          aa:bb:cc:dd:ee:01',
        '  wake broadcast    (default) the directed broadcast of the local network shared with the peer',
        '  probe window      8 s  --wake-probe: how long the connection is probed after each packet before the next one',
        '  total wait        90 s (default)  --wake-wait: total time to wait for the peer to answer',
        '  max unicast       4 (default)  --wake-max-unicast: unicast packets at most (0 = none)',
        '  max broadcast     4 (default)  --wake-max-broadcast: broadcast packets at most (0 = none)',
        '  connect timeout   3000 ms (default)  --wake-connect-timeout: limit of one probe attempt (connect and handshake; a host that just resumed answers TCP late and TLS later)',
        '  settle            0 s (default)  --wake-settle: pause after the peer answered, before the command (a host whose network answers before its daemon is ready)',
        '',
      ].join('\n'),
    );
  });

  it('--json is one document with the entry, the effective values and the defaulted fields', async () => {
    await connect(['laptop', '--wake-mac', 'aa:bb:cc:dd:ee:01', '--wake-wait', '120']);
    const r = await connect(['laptop', '--show', '--json']);
    const doc = JSON.parse(r.out) as { uuid: string; name: string; entry: { type: string; wake: { waitSeconds: number } }; effective: { waitSeconds: number; probeSeconds: number }; defaulted: string[] };
    expect(doc.uuid).toBe(laptop);
    expect(doc.entry.wake.waitSeconds).toBe(120);
    expect(doc.effective).toMatchObject({ waitSeconds: 120, probeSeconds: 5 });
    expect(doc.defaulted).toContain('probeSeconds');
    expect(doc.defaulted).not.toContain('waitSeconds');
  });
});

describe('machine peer connect <machine> (set)', () => {
  it('saves under the uuid, MAC normalised, and prints what it saved with the effective values', async () => {
    const r = await connect(['laptop', '--address', '192.168.1.40:47921', '--wake-mac', 'AA-BB-CC-DD-EE-01']);
    expect(r.code).toBe(0);
    expect(fileOf()).toEqual({
      v: 1,
      peers: { [laptop]: { type: 'ping-if-not-reachable-magic-packet', addresses: [{ host: '192.168.1.40', port: 47921 }], wake: { mac: 'aa:bb:cc:dd:ee:01' } } },
    });
    expect(r.out).toMatch(/\[ok\] "laptop": connection settings saved/);
    expect(r.out).toMatch(/wake mac\s+aa:bb:cc:dd:ee:01/);
    // A MAC without a type turns the automatic wake on, and says so.
    expect(r.err).toMatch(/\[info\] type set to ping-if-not-reachable-magic-packet because a MAC address was given/);
    expect(r.err).toMatch(/--type direct/);
  });

  it('several --address are all pinned, in order', async () => {
    await connect(['laptop', '--address', '192.168.1.40:47921', '--address', 'laptop.example.net:47921']);
    expect(fileOf().peers[laptop]).toEqual({ type: 'direct', addresses: [{ host: '192.168.1.40', port: 47921 }, { host: 'laptop.example.net', port: 47921 }] });
  });

  it('a flag overrides the stored value and keeps every other: the file is not rewritten from scratch', async () => {
    await connect(['laptop', '--address', '192.168.1.40:47921', '--wake-mac', 'aa:bb:cc:dd:ee:01', '--wake-probe', '8', '--wake-wait', '120']);
    const r = await connect(['laptop', '--wake-probe', '12', '--wake-settle', '3']);
    expect(r.code).toBe(0);
    expect(fileOf().peers[laptop]).toEqual({
      type: 'ping-if-not-reachable-magic-packet',
      addresses: [{ host: '192.168.1.40', port: 47921 }],
      wake: { mac: 'aa:bb:cc:dd:ee:01', probeSeconds: 12, waitSeconds: 120, settleSeconds: 3 },
    });
    expect(r.err).toMatch(/probe window: 8 s -> 12 s/);
    expect(r.err).toMatch(/settle: default -> 3 s/);
  });

  it('--type direct keeps the settings but stops the automatic wake', async () => {
    await connect(['laptop', '--wake-mac', 'aa:bb:cc:dd:ee:01']);
    await connect(['laptop', '--type', 'direct']);
    expect(fileOf().peers[laptop]).toMatchObject({ type: 'direct', wake: { mac: 'aa:bb:cc:dd:ee:01' } });
  });

  it('an alias and a uuid prefix resolve like everywhere else', async () => {
    await cli(a, ['alias', 'set', 'portable', 'laptop']);
    expect((await connect(['portable', '--wake-mac', 'aa:bb:cc:dd:ee:01'])).code).toBe(0);
    expect(Object.keys(fileOf().peers)).toEqual([laptop]);
    expect((await connect([laptop.slice(0, 8), '--wake-settle', '2'])).code).toBe(0);
  });

  describe('refuses, naming the flag and the allowed range, and writes nothing', () => {
    it.each([
      [['--wake-probe', '0'], /--wake-probe.*probeSeconds must be a whole number from 1 to 60/],
      [['--wake-probe', '61'], /from 1 to 60/],
      [['--wake-wait', '5'], /waitSeconds must be a whole number from 10 to 600/],
      [['--wake-wait', '601'], /from 10 to 600/],
      [['--wake-max-unicast', '9'], /maxUnicast must be a whole number from 0 to 8/],
      [['--wake-max-broadcast', '9'], /maxBroadcast must be a whole number from 0 to 8/],
      [['--wake-max-broadcast', '-1'], /needs a value|maxBroadcast must be/],
      [['--wake-connect-timeout', '50'], /connectTimeoutMs must be a whole number from 200 to 10000/],
      [['--wake-settle', '121'], /settleSeconds must be a whole number from 0 to 120/],
      [['--wake-probe', 'abc'], /probeSeconds must be a whole number/],
      [['--wake-probe', '2.5'], /probeSeconds must be a whole number/],
      [['--wake-max-unicast', '0', '--wake-max-broadcast', '0'], /no packet would ever be sent/],
      [['--wake-mac', 'not-a-mac'], /invalid MAC address "not-a-mac"/],
      [['--wake-mac', '00:00:00:00:00:00'], /not the address of one network card/],
      [['--wake-broadcast', '255.255.255'], /--wake-broadcast.*IPv4/],
      [['--type', 'ssh-proxy'], /--type must be one of direct, ping-if-not-reachable-magic-packet/],
      [['--address', 'nowhere'], /invalid --address "nowhere"/],
      [['--address', 'http://x:1'], /invalid --address/],
    ])('%j', async (flags, message) => {
      const r = await connect(['laptop', '--wake-mac', 'aa:bb:cc:dd:ee:01', ...(flags as string[])]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(message as RegExp);
      expect(existsSync(connectionsFile(a))).toBe(false);
    });

    it('a timing flag with no MAC configured says to set the MAC first', async () => {
      const r = await connect(['laptop', '--wake-probe', '8']);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--wake-probe needs the MAC address of "laptop".*--wake-mac/);
    });

    it('the automatic type with no MAC says to give one', async () => {
      const r = await connect(['laptop', '--type', 'ping-if-not-reachable-magic-packet']);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--wake-mac/);
    });

    it('more than 8 addresses', async () => {
      const many = Array.from({ length: 9 }, (_, i) => ['--address', `10.0.0.${i + 1}:47921`]).flat();
      const r = await connect(['laptop', ...many]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/at most 8/);
    });

    it('nothing to set: lists what can be given', async () => {
      const r = await connect(['laptop']);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/nothing to set.*--address.*--wake-mac.*--show.*--remove/s);
    });

    it('--show and --remove with settings, and each other', async () => {
      expect((await connect(['laptop', '--show', '--wake-probe', '5'])).code).toBe(2);
      expect((await connect(['laptop', '--show', '--remove'])).code).toBe(2);
      expect((await connect(['laptop', '--remove', '--address', '1.2.3.4:5'])).code).toBe(2);
    });

    it('an unknown machine is exit 3', async () => {
      const r = await connect(['nobody', '--wake-mac', 'aa:bb:cc:dd:ee:01']);
      expect(r.code).toBe(3);
      expect(r.err).toMatch(/nobody/);
    });

    it('this machine itself', async () => {
      const r = await connect(['desktop', '--wake-mac', 'aa:bb:cc:dd:ee:01']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/that is this machine/);
    });
  });

  it('a corrupt connections.json stops with the path and the fix, and is not overwritten', async () => {
    writeFileSync(connectionsFile(a), '{ nope');
    const r = await connect(['laptop', '--wake-mac', 'aa:bb:cc:dd:ee:01']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(connectionsFile(a));
    expect(r.err).toMatch(/not valid JSON/);
    expect(readFileSync(connectionsFile(a), 'utf8')).toBe('{ nope');
  });

  it('a hand-edited unknown field is refused by every command that reads the file', async () => {
    writeFileSync(connectionsFile(a), JSON.stringify({ v: 1, peers: { [laptop]: { type: 'direct', proxyCommand: 'nc %h %p' } } }));
    const show = await connect(['laptop', '--show']);
    expect(show.code).toBe(1);
    expect(show.err).toMatch(/unknown field "proxyCommand"/);
    const ping = await cli(a, ['ping', 'laptop']);
    expect(ping.code).toBe(1);
    expect(ping.err).toMatch(/unknown field "proxyCommand"/);
  });
});

describe('machine peer connect <machine> --remove', () => {
  it('removes the entry, keeps the others', async () => {
    await connect(['laptop', '--wake-mac', 'aa:bb:cc:dd:ee:01']);
    const r = await connect(['laptop', '--remove']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[ok\] "laptop": connection settings removed/);
    expect(fileOf().peers).toEqual({});
  });

  it('says so when there was nothing to remove', async () => {
    const r = await connect(['laptop', '--remove']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[info\] "laptop" has no connection settings: nothing to remove/);
  });
});

describe('flags are accepted only where they mean something', () => {
  it.each([
    [['status', '--wake'], /--wake only applies to `machine run` and `machine ping`/],
    [['run', 'laptop', '--no-wake', '--wake', '--', 'echo'], /--wake and --no-wake cannot be combined/],
    [['run', 'laptop', '--wake-probe', '5', '--', 'echo'], /--wake-probe only applies to `machine peer connect`/],
    [['ping', '--wake-mac', 'aa:bb:cc:dd:ee:01'], /--wake-mac only applies to `machine peer connect`/],
    [['ping', '--type', 'direct'], /--type only applies to `machine peer connect`/],
    [['ping', '--show'], /--show only applies to `machine peer connect`/],
    [['ping', 'laptop', '--address', '1.2.3.4:5', '--address', '1.2.3.4:6'], /--address can be given only once/],
    [['ping', '--wake'], /--wake applies to `machine ping <machine>`/],
  ])('%j', async (argv, message) => {
    const r = await cli(a, argv as string[]);
    expect(r.code === 2 || r.code === 255).toBe(true);
    expect(r.err).toMatch(message as RegExp);
  });
});

describe('machine peer wake <machine>', () => {
  const fakeSender = (sent: string[]): WakeSender => ({
    send: async (method, _packet, routes) => {
      sent.push(method);
      return { destinations: routes.map((r) => ({ method, to: method === 'unicast' ? (r.unicast[0] as string) : r.broadcast, from: r.localAddress, ok: true })) };
    },
  });
  const noSleep = { sleep: async () => undefined, nowMs: (() => { let t = 0; return () => (t += 1000); })() };
  const wakeCli = (args: string[], wake: object) => cli(a, ['peer', 'wake', ...args], undefined, { wake } as never);

  it('with no MAC configured: exit 1 with the command that sets it', async () => {
    const r = await wakeCli(['laptop'], {});
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no MAC address is configured for "laptop".*machine peer connect laptop --wake-mac aa:bb:cc:dd:ee:ff/);
  });

  it('a peer that is not on this LAN: nothing is sent, the error says why (exit 1)', async () => {
    await connect(['laptop', '--address', '127.0.0.1:1', '--wake-mac', 'aa:bb:cc:dd:ee:01']);
    const sent: string[] = [];
    const r = await wakeCli(['laptop'], { sender: fakeSender(sent), interfaces: () => [{ name: 'tun0', address: '10.8.0.5', netmask: '255.255.255.0', internal: false }], simulateFailure: () => 'timeout', ...noSleep });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\] .*"laptop" is unreachable .*Wake-on-LAN cannot be tried: this machine is not on the same network as laptop/);
    expect(r.err).toMatch(/nothing was sent/);
    expect(sent).toEqual([]);
    expect(existsSync(wakeAuditFile(a))).toBe(false);
  });
});
