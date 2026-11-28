import { describe, expect, it } from 'vitest';
import { loadFailureView, SOURCE_ROUTES, SOURCE_SUBJECTS } from './loadFailure.js';

// A failed load of a page source (`$ctx.$sourceErrors.<source>`: { message, status? }) is NOT always an error and not always our bug (UX requirement 2026-11-28): the page
// tells three cases apart, and a command is never the headline.
//   1. internal error (a bug of the module or of this page): says so, copies its details, needs no command;
//   2. not configured (no admin relay token): "to configure", a button that logs in from the page (a copyable command only where the page cannot do it);
//   3. external (the relay does not answer): the cause and Retry.
// The decision reads the message and the status because `$sourceErrors` carries nothing else; the real messages of the backend are pinned in the module
// (app-module-machine backend/failureKinds.test.ts), so a reworded message fails there.

const NO_TOKEN = 'this machine holds no admin relay token (no /home/user/.config/machine/_secrets_/relay-admin.json): approving a machine needs the admin relay token (limited to machine rights, it cannot manage tokens). Run `machine admin login` and confirm the request in the relay console (Tokens page, the request marked MACHINE ADMIN: it can approve machines and cannot manage tokens); or with a pairing code: in the relay console open Tokens, Add token, "Limited to scopes", machine-admin, then run `machine admin login <code>`';
const RELAY_502 = 'the relay is unreachable at https://relay.example.net (fetch failed): check the network and that the relay runs';
const SUBJECT = 'the candidacies';

describe('case 2, not configured: no admin relay token', () => {
  const view = loadFailureView(SUBJECT, { message: NO_TOKEN, status: 503 });

  it('is a to-configure state with the login button, not an error', () => {
    expect(view.kind).toBe('not-configured');
    expect(view.tone).toBe('info');
    expect(view.canLogin).toBe(true);
    expect(view.headline).toBe('To see the candidacies, this machine needs an admin relay token. It has none yet.');
  });

  it('the headline holds no command; the command is kept for the folded details', () => {
    expect(view.headline).not.toMatch(/`|machine admin/);
    expect(view.command).toBe('machine admin login');
  });

  it('keeps the whole message and the status in the details', () => {
    expect(view.details).toContain(NO_TOKEN);
    expect(view.details).toContain('HTTP 503');
  });
});

describe('case 2 where the page cannot act: the token file is damaged, the token is refused, the machine has no identity', () => {
  it.each([
    ['a damaged token file', 503, '/home/u/.config/machine/_secrets_/relay-admin.json is corrupt or invalid (not valid JSON): delete it and run `machine admin login --force` and confirm the request in the relay console', 'machine admin login --force', 'Setup needed: /home/u/.config/machine/_secrets_/relay-admin.json is corrupt or invalid.'],
    ['a refused token', 401, 'the relay refused the admin token (invalid or revoked): run `machine admin login --force` and confirm the request in the relay console', 'machine admin login --force', 'Setup needed: the relay refused the admin token.'],
    ['a plain machine token', 403, 'the token saved by `machine admin login` is a plain machine token, so it cannot list candidacies (x). Run `machine admin login --force` and confirm', 'machine admin login --force', 'Setup needed: the token saved by `machine admin login` is a plain machine token, so it cannot list candidacies.'],
    ['a relay URL that is not accepted', 503, 'the relay URL in /x/relay-admin.json must use https (plain http is only accepted for the literals 127.0.0.1 and [::1]): the token is not sent; run `machine admin login --force`', 'machine admin login --force', 'Setup needed: the relay URL in /x/relay-admin.json must use https.'],
    ['a machine without identity', 409, 'this machine has no identity yet: run `machine setup <relay>` (the first machine of a network) or `machine join <relay>` (any other machine), which create it', 'machine setup <relay>', 'Setup needed: this machine has no identity yet.'],
  ])('%s: a neutral to-configure state, one sentence, the command to copy (no login button: the page cannot replace or create it)', (_name, status, message, command, headline) => {
    const view = loadFailureView(SUBJECT, { message, status });
    expect(view.kind).toBe('setup-manual');
    expect(view.tone).toBe('info');
    expect(view.canLogin).toBe(false);
    expect(view.command).toBe(command);
    expect(view.headline).toBe(headline);
  });
});

describe('case 3, external: the relay does not answer', () => {
  it('names the cause and its short fix, offers Retry, says nothing about a command', () => {
    const view = loadFailureView(SUBJECT, { message: RELAY_502, status: 502 });
    expect(view.kind).toBe('relay');
    expect(view.tone).toBe('danger');
    expect(view.canLogin).toBe(false);
    expect(view.headline).toBe('Could not load the candidacies: the relay is unreachable at https://relay.example.net. Check the network and that the relay runs.');
    expect(view.command).toBeUndefined();
    expect(view.headline).not.toMatch(/`|Run /);
  });

  it.each([
    'the relay answered 503 to the candidacy list (maintenance)',
    'the relay answer is larger than 1 MiB: refused',
    'the relay answer has no "candidacies" list: it may be an incompatible version',
  ])('%s is the relay (HTTP 502)', (message) => {
    expect(loadFailureView(SUBJECT, { message, status: 502 }).kind).toBe('relay');
  });
});

describe('the machine daemon', () => {
  it('not running: not our bug, the daemon is to be started, Retry and the command to copy', () => {
    const view = loadFailureView('the machines', { message: 'the machine daemon is not running (no /h/daemon.port.json): start it with `machine daemon` (or its orch job) and reload the page', status: 503 });
    expect(view.kind).toBe('daemon-down');
    expect(view.tone).toBe('warning');
    expect(view.headline).toBe('Could not reach the machine daemon, so the machines cannot be loaded.');
    expect(view.command).toBe('machine daemon');
  });

  it('does not answer on its port, or has no token file: the same state', () => {
    expect(loadFailureView('the machines', { message: 'the machine daemon does not answer on 127.0.0.1:5000 (connect ECONNREFUSED): the port file may be stale; start it with `machine daemon` (or its orch job) and reload the page', status: 503 }).kind).toBe('daemon-down');
    expect(loadFailureView('the machines', { message: '/h/health_token is missing: the daemon wrote its port file but not its token (it may have stopped in between); restart it with `machine daemon`', status: 503 }).kind).toBe('daemon-down');
  });

  it('refused its token: both commands, one per line', () => {
    const view = loadFailureView('the machines', { message: 'the daemon refused the token read from /h/health_token: it belongs to another daemon run; restart the daemon (`machine stop` then `machine daemon`)', status: 502 });
    expect(view.kind).toBe('daemon-down');
    expect(view.command).toBe('machine stop\nmachine daemon');
  });

  it('older than the module: the fix is the update', () => {
    const view = loadFailureView('the allow lists', { message: 'the daemon failed the command "allowed": Unknown command: allowed: the daemon is older than this module, update it with `machine cli update` and restart it', status: 502 });
    expect(view.kind).toBe('daemon-old');
    expect(view.command).toBe('machine cli update');
    expect(view.headline).toBe('The machine daemon is older than this module, so the allow lists cannot be loaded.');
  });
});

describe('case 1, internal error: a bug of the module or of this page', () => {
  it.each([
    ['500', 500, 'boom'],
    ['a route the module does not have', 404, 'Route GET:/api/modules/machine/requests not found'],
    ['an answer the daemon gave that this module does not understand', 502, 'the daemon failed the command "requests": status 500'],
  ])('%s says it is internal, offers Retry and Copy details, and names no command', (_name, status, message) => {
    const view = loadFailureView(SUBJECT, { message, status }, 'candidacies');
    expect(view.kind).toBe('internal');
    expect(view.tone).toBe('danger');
    expect(view.headline).toMatch(/^Internal error: the candidacies could not be loaded/);
    expect(view.headline).not.toMatch(/`|Run /);
    expect(view.command).toBeUndefined();
    expect(view.canLogin).toBe(false);
  });

  it('Copy details holds the cause, the route and the status', () => {
    const view = loadFailureView(SUBJECT, { message: 'boom', status: 500 }, 'candidacies');
    expect(view.copyText).toContain('Message: boom');
    expect(view.copyText).toContain('Route: GET /api/modules/machine/candidacies');
    expect(view.copyText).toContain('HTTP status: 500');
    expect(view.copyText).toContain('Source: candidacies');
  });

  it('a source with no known route says so instead of guessing one', () => {
    expect(loadFailureView(SUBJECT, { message: 'boom', status: 500 }, 'mystery').copyText).toContain('Route: unknown (source "mystery" is not one of the module sources)');
    expect(loadFailureView(SUBJECT, { message: 'boom', status: 500 }).copyText).toContain('Route: unknown (no source named)');
  });

  it('a bad query (HTTP 400: a page past the end, typed in the address) is the user own doing, not a bug: unexpected, the sentence of the backend with its fix', () => {
    const view = loadFailureView('the activity', { message: 'page 9 is beyond the last page (2): 30 entries match at 25 per page. Ask for a page from 1 to 2', status: 400 }, 'activity');
    expect(view.kind).toBe('unexpected');
    expect(view.headline).toBe('Could not load the activity: page 9 is beyond the last page. 30 entries match at 25 per page. Ask for a page from 1 to 2.');
  });

  it('a fix that holds a command is kept in the sentence of an unrecognised failure, and the command can be copied', () => {
    const view = loadFailureView('the activity', { message: 'the app-core shell does not provide appFetcher(): update app-core (`app-core-cli update`) and reload the page' });
    expect(view.kind).toBe('unexpected');
    expect(view.headline).toBe('Could not load the activity: the app-core shell does not provide appFetcher(). Update app-core (`app-core-cli update`) and reload the page.');
    expect(view.command).toBe('app-core-cli update');
  });

  it('no status at all (the page could not reach the app): unexpected, with Copy details, never presented as a bug of the module', () => {
    const view = loadFailureView(SUBJECT, { message: 'Failed to fetch' });
    expect(view.kind).toBe('unexpected');
    expect(view.headline).toBe('Could not load the candidacies: Failed to fetch.');
    expect(view.copyText).toContain('HTTP status: none');
  });
});

describe('shape of the text', () => {
  it('a message with nothing to cut is the cause as it is, without a double full stop', () => {
    expect(loadFailureView('the machines', { message: 'boom.' }).headline).toBe('Could not load the machines: boom.');
    expect(loadFailureView('the machines', { message: 'boom' }).details).toBe('boom');
  });

  it('a long remainder with no command is not repeated in the headline (it is in the details)', () => {
    const long = `the daemon refused: ${'x'.repeat(200)}`;
    expect(loadFailureView('the machines', { message: long }).headline).toBe('Could not load the machines: the daemon refused.');
  });
});

describe('the routes named by Copy details are the ones of the module sources', () => {
  it('has a subject sentence for every route', () => {
    expect(Object.keys(SOURCE_SUBJECTS).sort()).toEqual(Object.keys(SOURCE_ROUTES).sort());
  });
});
