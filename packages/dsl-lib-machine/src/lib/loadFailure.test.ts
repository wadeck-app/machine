import { describe, expect, it } from 'vitest';
import { loadFailureView } from './loadFailure.js';

// A failed load of a page source (`$ctx.$sourceErrors.<source>`: { message, status? }) as ONE line above the table: the cause, then the exact command when the message
// holds one (or its fix when it is short); the whole message is folded under it.

const RELAY_503 = 'this machine holds no admin relay token (no /home/user/.config/machine/relay-admin.json): approving a machine needs the admin relay token (limited to machine rights, it cannot manage tokens). Run `machine admin login` and confirm the request in the relay console (Tokens page); or with a pairing code: run `machine admin login <code>`';
const RELAY_502 = 'the relay is unreachable at https://relay.example.net (fetch failed): check the network and that the relay runs';

describe('loadFailureView', () => {
  it('a missing token: the cause up to its parenthesis, then the first command of the message in code', () => {
    const view = loadFailureView('Could not load the candidacies', { message: RELAY_503, status: 503 });
    expect(view.label).toBe('Could not load the candidacies: this machine holds no admin relay token. Run `machine admin login`.');
  });

  it('an unreachable relay: no command in the message, its short fix is kept', () => {
    expect(loadFailureView('Could not load the machines', { message: RELAY_502, status: 502 }).label).toBe('Could not load the machines: the relay is unreachable at https://relay.example.net. Check the network and that the relay runs.');
  });

  it('the whole message and the status are in the details', () => {
    const view = loadFailureView('Could not load the candidacies', { message: RELAY_503, status: 503 });
    expect(view.details).toContain(RELAY_503);
    expect(view.details).toContain('HTTP 503');
  });

  it('a message with nothing to cut is the cause as it is, without a double full stop', () => {
    expect(loadFailureView('Could not load the machines', { message: 'boom.' }).label).toBe('Could not load the machines: boom.');
    expect(loadFailureView('Could not load the machines', { message: 'boom' }).details).toBe('boom');
  });

  it('a long remainder with no command is not repeated in the line (it is in the details)', () => {
    const long = `the daemon refused: ${'x'.repeat(150)}`;
    expect(loadFailureView('Could not load the machines', { message: long }).label).toBe('Could not load the machines: the daemon refused.');
  });
});
