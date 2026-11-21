import { describe, expect, it } from 'vitest';
import { peerBindNotice } from './peerBindNotice.js';

describe('peerBindNotice', () => {
  it('default bind (0.0.0.0, no --peer-host): prints the host and a loud warning with the exact fix', () => {
    const n = peerBindNotice({ host: '0.0.0.0', explicit: false });
    expect(n.host).toBe('0.0.0.0');
    expect(n.warning).toMatch(/^\[warn\] /);
    expect(n.warning).toContain('0.0.0.0');
    expect(n.warning).toMatch(/every interface/);
    expect(n.warning).toMatch(/TLS 1\.3/);
    expect(n.warning).toMatch(/pinned/);
    expect(n.warning).toContain('--peer-host <address>');
    expect(n.warning).not.toContain('\n');
  });

  it.each(['127.0.0.1', '127.9.9.9', '::1', '[::1]', 'localhost'])('loopback %s without --peer-host: no warning', (host) => {
    expect(peerBindNotice({ host, explicit: false }).warning).toBeUndefined();
  });

  it.each(['0.0.0.0', '::', '192.168.1.20', '10.0.0.5'])('explicit --peer-host %s: the host is printed, no warning', (host) => {
    const n = peerBindNotice({ host, explicit: true });
    expect(n.host).toBe(host);
    expect(n.warning).toBeUndefined();
  });

  it('a non-loopback host that is not explicit (a future default) is still warned about', () => {
    expect(peerBindNotice({ host: '::', explicit: false }).warning).toMatch(/^\[warn\] /);
  });
});
