import { describe, expect, it } from 'vitest';
import { relayLines, type PeerRelayInfo } from './listPresence.js';

const local = (h: number, mi: number): number => Math.floor(new Date(2026, 10, 15, h, mi).getTime() / 1000);

describe('relayLines: times are local with a relative hint (UX audit)', () => {
  const now = local(14, 20);
  const base: PeerRelayInfo = { source: 'relay', addresses: [{ host: '203.0.113.7', port: 7420 }], online: false };

  it('offline with a last seen time: "last seen 3 min ago (14:17)", no UTC', () => {
    const lines = relayLines({ ...base, lastSeen: local(14, 17) }, now);
    expect(lines).toEqual(['  relay: offline, last seen 3 min ago (14:17), 203.0.113.7:7420']);
    expect(lines.join('\n')).not.toMatch(/Z|T\d\d:/);
  });

  it('offline without a last seen time says so plainly', () => {
    expect(relayLines({ ...base, lastSeen: null }, now)).toEqual(['  relay: offline, 203.0.113.7:7420']);
  });

  it('online and presence unknown are unchanged', () => {
    expect(relayLines({ ...base, online: true }, now)).toEqual(['  relay: online, 203.0.113.7:7420']);
    const { online: _online, ...unknown } = base;
    expect(relayLines(unknown, now)).toEqual(['  relay: presence unknown, 203.0.113.7:7420']);
  });
});
