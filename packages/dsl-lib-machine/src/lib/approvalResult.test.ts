import { describe, expect, it } from 'vitest';
import { dedupeReport, describeDelivery, type DeliveryMachine } from './approvalResult.js';

// The short outcome of the delivery shown above the security code (admin-ui.md, "Approve from the page"): one headline, a tone, how many machines wait in the relay
// inbox. The raw CLI text goes to a collapsed "Details", without the lines it repeats.

const RETRY = 'machine admin distribute 22222222-2222-4222-8222-222222222222';
const machine = (over: Partial<DeliveryMachine> = {}): DeliveryMachine => ({ uuid: 'u', name: 'server', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do', ...over });
const inbox = (over: Partial<DeliveryMachine> = {}): DeliveryMachine => machine({ state: 'inbox', code: 'unreachable', reason: 'offline', next: 'installs by itself when it is back, nothing to do', ...over });
const failed = (over: Partial<DeliveryMachine> = {}): DeliveryMachine => machine({ state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\``, ...over });

describe('describeDelivery', () => {
  it('nobody to tell: the first machine of the network', () => {
    expect(describeDelivery('none', [], RETRY)).toEqual({ headline: 'No other machine to tell: this is the first machine of the network.', tone: 'success', waiting: 0 });
  });

  it('every machine took its documents', () => {
    expect(describeDelivery('delivered', [machine(), machine({ name: 'nas' })], RETRY)).toEqual({ headline: 'Documents delivered to 2 machines.', tone: 'success', waiting: 0 });
    expect(describeDelivery('delivered', [machine()], RETRY).headline).toBe('Documents delivered to 1 machine.');
  });

  it('one delivered, one waiting in the relay inbox: said in one line, nothing to do', () => {
    expect(describeDelivery('delivered', [machine(), inbox({ name: 'laptop' })], RETRY)).toEqual({ headline: 'Documents delivered to 1 machine, 1 waits in the relay inbox.', tone: 'success', waiting: 1 });
  });

  it('several waiting', () => {
    expect(describeDelivery('delivered', [machine(), inbox(), inbox()], RETRY).headline).toBe('Documents delivered to 1 machine, 2 wait in the relay inbox.');
  });

  it('all waiting: no machine is "delivered"', () => {
    expect(describeDelivery('delivered', [inbox(), inbox()], RETRY)).toMatchObject({ headline: 'Documents wait in the relay inbox of 2 machines.', waiting: 2 });
    expect(describeDelivery('delivered', [inbox()], RETRY).headline).toBe('Documents wait in the relay inbox of 1 machine.');
  });

  it('a machine in the inbox that needs an action (older build, refusal) turns the tone to warning', () => {
    for (const code of ['peer-too-old', 'refused', 'unexpected-answer'] as const) {
      expect(describeDelivery('delivered', [machine(), inbox({ code })], RETRY).tone).toBe('warning');
    }
  });

  it('a failure: the headline names how many were NOT told and the exact retry command', () => {
    const out = describeDelivery('partial', [machine(), failed()], RETRY);
    expect(out.tone).toBe('warning');
    expect(out.headline).toBe(`Documents delivered to 1 machine, 1 NOT told. Run \`${RETRY}\`.`);
    expect(describeDelivery('partial', [machine(), inbox(), failed()], RETRY).headline).toBe(`Documents delivered to 1 machine, 1 waits in the relay inbox, 1 NOT told. Run \`${RETRY}\`.`);
  });

  it('nothing reached anybody: danger', () => {
    const out = describeDelivery('partial', [failed(), failed({ name: 'nas' })], RETRY);
    expect(out.tone).toBe('danger');
    expect(out.headline).toBe(`Documents NOT delivered to 2 machines. Run \`${RETRY}\`.`);
  });

  it('the delivery could not be asked at all (no machine list): the others were NOT told, run the command, safe to run again', () => {
    const out = describeDelivery('failed', [], RETRY);
    expect(out.tone).toBe('danger');
    expect(out.headline).toBe(`The other machines were NOT told. Run \`${RETRY}\` on this machine; it is safe to run again.`);
  });

  it('a partial status with no machine in the list still says what to run', () => {
    expect(describeDelivery('partial', [], RETRY)).toMatchObject({ tone: 'warning', headline: `Some machines were NOT told. Run \`${RETRY}\`.` });
  });
});

describe('dedupeReport', () => {
  it('keeps the order and drops a line that was already said (the boilerplate of each machine, a repeated warning)', () => {
    const text = ['[ok] a', '[info] sealed', '[warn] retry', '[info] sealed', '', '[warn] retry', '[error] b'].join('\n');
    expect(dedupeReport(text)).toBe(['[ok] a', '[info] sealed', '[warn] retry', '[error] b'].join('\n'));
  });

  it('an empty report stays empty', () => {
    expect(dedupeReport('')).toBe('');
  });
});
