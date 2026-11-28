import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DeliveryMachine } from '../lib/approvalResult.js';
import { DeliveryList } from './DeliveryList.js';

// One short line per machine: state, one reason, and a next action ONLY when there is something to do (UX review: no bare "nothing to do", no command said twice).

const RETRY = 'machine admin distribute 22222222-2222-4222-8222-222222222222';
const m = (over: Partial<DeliveryMachine>): DeliveryMachine => ({ uuid: 'u', name: 'server', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do', ...over });

describe('DeliveryList', () => {
  it('a bare "nothing to do" is not a line', () => {
    render(<DeliveryList machines={[m({})]} text="" openDetails={false} />);
    const item = within(screen.getByRole('list', { name: 'Machines told' })).getByRole('listitem');
    expect(item).toHaveTextContent('took the documents directly');
    expect(item).not.toHaveTextContent(/nothing to do/i);
  });

  it('a next action that is a real action is shown, its command in monospace and without backticks', () => {
    render(<DeliveryList machines={[m({ uuid: 'a', name: 'phone', state: 'inbox', code: 'peer-too-old', reason: 'too old', next: 'update it with `app-core-cli update` there' })]} text="" openDetails={false} />);
    expect(screen.getByText('app-core-cli update')).toBeInTheDocument();
    expect(screen.getByRole('list').textContent).not.toContain('`');
  });

  it('a note that only reassures ("installs by itself when it is back, nothing to do") is kept: it explains the waiting', () => {
    render(<DeliveryList machines={[m({ state: 'inbox', code: 'unreachable', reason: 'offline', next: 'installs by itself when it is back, nothing to do' })]} text="" openDetails={false} />);
    expect(screen.getByRole('list')).toHaveTextContent('installs by itself when it is back, nothing to do');
  });

  it('the command the result already says above (its headline) is not repeated on each machine', () => {
    render(<DeliveryList machines={[m({ uuid: 'a', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` }), m({ uuid: 'b', name: 'mac', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` })]} said={RETRY} text="" openDetails={false} />);
    expect(screen.queryByText(RETRY)).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
