import type { MockRoutes } from './mockRoutes.js';
import { candidaciesRoutes } from './candidaciesMock.js';
import type { CandidaciesState } from './candidaciesState.js';
import { machinesRoutes } from './machinesMock.js';
import { machinesSeed, type MachinesSeedName } from './machinesSeeds.js';
import approvalCodesRecallable from './scenarioSeeds/approval-codes-recallable.json';
import approveResultDelivered from './scenarioSeeds/approve-result-delivered.json';
import approveResultFailed from './scenarioSeeds/approve-result-failed.json';
import approveResultPartial from './scenarioSeeds/approve-result-partial.json';
import candidateExpired from './scenarioSeeds/candidate-expired.json';
import empty from './scenarioSeeds/empty.json';
import onePending from './scenarioSeeds/one-pending.json';
import pendingRevokedEarlier from './scenarioSeeds/pending-revoked-earlier.json';
import pendingWithProblems from './scenarioSeeds/pending-with-problems.json';
import internalError500 from './scenarioSeeds/internal-error-500.json';
import relayError503 from './scenarioSeeds/relay-error-503.json';
import relayUnreachable502 from './scenarioSeeds/relay-unreachable-502.json';
import severalPending from './scenarioSeeds/several-pending.json';

// The scenarios of the module (dev-only mocks of a page, see "Scenarios" of module-authoring.md): the Candidacies page (`/candidacies`) and the Machines page (`/`).
// Plain objects (structurally the `ScenarioDefinition` of the SDK): src/dsl-scenarios/index.ts hands them to `defineScenarios`. They live in src/commons because the
// module check forbids src/backend (where their tests are) to import src/dsl-scenarios. BROWSER code: no Node API, no package. The data is fake
// (src/commons/scenarioSeeds, machinesSeeds.ts); the logic is the pure state machines of src/commons, so that Approve / Reject / Revoke change what the next request
// returns. Pick one in the A/B dock of the dev server or with `?scenario=<id>`, see .claude/specs/2026-11-13_machine-network/scenarios.md.

/** One scenario of the dock. */
export interface ScenarioDef {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly pages: readonly string[];
  readonly create: () => { readonly routes: MockRoutes };
}

/**
 * The passphrase of the admin key of the scenarios. It is a FIXTURE, not a secret: the key (an obviously fake one, see seedBuilders.testUtil.ts) exists only for the
 * scenarios and is trusted by no machine. It is published here, in the hints and nowhere else (the hint of the key file cannot hold it: machine-core refuses a hint
 * that contains the passphrase).
 */
export const SCENARIO_PASSPHRASE = 'scenario-passphrase-2026';

// What every scenario where something can be signed says: the signature is real (a throwaway key, signed registrations), so the dialog goes up to the result view.
const SIGN = `Scenario key: passphrase ${SCENARIO_PASSPHRASE}, trusted by nothing. Type it in the dialog to reach the result view; any other passphrase shows the "wrong passphrase" message.`;

interface CandidaciesScenario {
  id: string;
  label: string;
  hint: string;
  seed: CandidaciesState;
}

const candidacies: CandidaciesScenario[] = [
  { id: 'empty', label: 'No candidacy', hint: 'Look at the empty table and the timeline with every step still to do.', seed: empty as CandidaciesState },
  { id: 'one-pending', label: 'One candidacy pending', hint: `A first enrollment (mac-m2, 4 minutes old): open the row, then Reject it (the row goes) or press Approve. ${SIGN}`, seed: onePending as CandidaciesState },
  {
    id: 'several-pending',
    label: 'Several candidacies pending',
    hint: `Two rows, the timeline follows the oldest; thinkcentre reuses a uuid bound to a revoked token (warning in the dialog). ${SIGN}`,
    seed: severalPending as CandidaciesState,
  },
  {
    id: 'pending-revoked-earlier',
    label: 'Candidate revoked earlier',
    hint: `mac-m2 was revoked at serial 3: the dialog warns REVOKED and prints no code to compare. ${SIGN}`,
    seed: pendingRevokedEarlier as CandidaciesState,
  },
  {
    id: 'pending-with-problems',
    label: 'Candidacy with problems',
    hint: 'No uuid in the candidacy: the status text names the problem, Approve is not offered, Reject still works.',
    seed: pendingWithProblems as CandidaciesState,
  },
  {
    id: 'relay-error-503',
    label: 'No admin relay token (to configure)',
    hint: 'Not an error: a to-configure state with the button "Log in to the relay". Press it: the code appears, the mock admin confirms in the relay console after 8 seconds, then the list loads. No PIN in a scenario.',
    seed: relayError503 as CandidaciesState,
  },
  { id: 'relay-unreachable-502', label: 'Relay unreachable (502)', hint: 'The relay does not answer: the cause and a Retry button (it asks the sources again and the failure stays: the scenario never recovers).', seed: relayUnreachable502 as CandidaciesState },
  { id: 'internal-error-500', label: 'Internal error (500)', hint: 'A bug of the module: the page says it is an internal error and offers Retry and Copy details (cause, route, status), no command.', seed: internalError500 as CandidaciesState },
  {
    id: 'approve-result-delivered',
    label: 'Approval: documents delivered',
    hint: `Planned delivery: thinkcentre and mac-m2 take the documents directly. ${SIGN}`,
    seed: approveResultDelivered as CandidaciesState,
  },
  {
    id: 'approve-result-partial',
    label: 'Approval: delivery partial',
    hint: `Planned delivery: mac-m2 delivered, thinkcentre waits in the relay inbox. ${SIGN}`,
    seed: approveResultPartial as CandidaciesState,
  },
  {
    id: 'approve-result-failed',
    label: 'Approval: delivery failed',
    hint: `Planned delivery: the relay refuses the documents, both machines failed and the retry command is shown. ${SIGN}`,
    seed: approveResultFailed as CandidaciesState,
  },
  {
    id: 'approval-codes-recallable',
    label: 'Security codes kept',
    hint: 'mac-m2 was approved 4 minutes ago: look at its code on the last step of the timeline, and the older reminder below (2 days).',
    seed: approvalCodesRecallable as CandidaciesState,
  },
  { id: 'candidate-expired', label: 'Candidacy expired', hint: 'Posted 20 minutes ago, expired for 5: the row says why it cannot be decided (no Approve, no Reject).', seed: candidateExpired as CandidaciesState },
];

interface MachinesScenario {
  id: MachinesSeedName;
  label: string;
  hint: string;
}

const machines: MachinesScenario[] = [
  { id: 'only-this-machine', label: 'Only this machine', hint: 'A single row (this machine) and no Revoke button: nothing else is trusted yet.' },
  {
    id: 'two-trusted-peers',
    label: 'Two trusted peers',
    hint: `thinkcentre is reachable directly, mac-m2 is not (notice and reachability columns); Revoke opens the dialog. ${SIGN}`,
  },
  {
    id: 'peer-revoked-earlier',
    label: 'A peer was revoked earlier',
    hint: `mac-m2 (revoked, serial 3) is gone from the list; only thinkcentre can be revoked, and nobody else is left to tell. ${SIGN}`,
  },
  {
    id: 'revoke-delivered',
    label: 'Revoke: documents delivered',
    hint: `Planned delivery after a Revoke of mac-m2: thinkcentre takes the documents directly (success notice). ${SIGN}`,
  },
  {
    id: 'revoke-partial',
    label: 'Revoke: delivery partial',
    hint: `Planned delivery after a Revoke of mac-m2: thinkcentre is offline, its document waits in the relay inbox (warning). ${SIGN}`,
  },
  {
    id: 'revoke-failed',
    label: 'Revoke: delivery failed',
    hint: `Planned delivery after a Revoke of mac-m2: the relay refuses the document; the revocation stands and the retry command is shown. ${SIGN}`,
  },
  {
    id: 'relay-unreachable',
    label: 'Revoke: relay unreachable',
    hint: `Planned delivery after a Revoke of mac-m2: the relay is down, nobody is told and mac-m2 is not removed from the relay (both listed as failed). ${SIGN}`,
  },
  {
    id: 'rename-delivered',
    label: 'Rename: documents delivered',
    hint: `Rename mac-m2 (row action): thinkcentre and the renamed machine take the documents directly. Try a refused name first: thinkcentre (taken), think-centre (lookalike), tc (local alias of thinkcentre). ${SIGN}`,
  },
  {
    id: 'rename-partial',
    label: 'Rename: delivery partial',
    hint: `Rename mac-m2: thinkcentre takes the documents, the renamed machine does not (failed): the headline, the line per machine and Retry delivery, which delivers it to the relay inbox. ${SIGN}`,
  },
  {
    id: 'rename-failed',
    label: 'Rename: delivery failed',
    hint: `Rename mac-m2: the relay refuses every document; the rename stands, both machines are listed as failed with the terminal command folded; Retry delivery sends them. ${SIGN}`,
  },
  {
    id: 'alias-set',
    label: 'Aliases: set (a local alias wins)',
    hint: `Aliases (row action): the network list holds tc for mac-m2 and work for thinkcentre, while this machine has the local alias tc for thinkcentre (warning: the local one wins here). Add an alias, delivered directly. ${SIGN}`,
  },
  {
    id: 'alias-remove',
    label: 'Aliases: remove',
    hint: `Aliases: Remove box or work; each removal is its own passphrase and its own result. ${SIGN}`,
  },
  {
    id: 'alias-conflict',
    label: 'Aliases: refusals and a conflict',
    hint: `Aliases: no network alias yet and the local alias tc (thinkcentre). Add thinkcentre (refused: a machine name), think-centre (refused: a lookalike), then tc for mac-m2 (accepted, with the warning that the local alias wins). ${SIGN}`,
  },
  {
    id: 'alias-partial',
    label: 'Aliases: delivery partial',
    hint: `Aliases: add an alias; thinkcentre takes the list, mac-m2 does not (failed): Retry delivery delivers it to the relay inbox. ${SIGN}`,
  },
];

export const SCENARIOS: readonly ScenarioDef[] = [
  ...candidacies.map((s) => ({
    id: s.id,
    label: s.label,
    hint: s.hint,
    pages: ['/candidacies'],
    // A fresh state at every call: picking the scenario again, or Reset, starts again from the seed.
    create: () => ({ routes: candidaciesRoutes(s.seed, () => Date.now() / 1000) }),
  })),
  ...machines.map((s) => ({
    id: s.id,
    label: s.label,
    hint: s.hint,
    pages: ['/'],
    create: () => ({ routes: machinesRoutes(machinesSeed(s.id)) }),
  })),
];

