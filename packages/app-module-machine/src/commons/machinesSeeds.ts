import base from './scenarioSeeds/approval-codes-recallable.json';
import type { MachinesState, PeerEntry, RevokePlan } from './machinesState.js';
import type { SignedRegistrationWire } from './routeContracts.js';

// The initial states of the Machines scenarios, built from the FAKE material of the Candidacies seeds (admin machine, its placeholder key file, the registrations of two
// peers signed with a fake key): nothing here belongs to a real network. BROWSER-SAFE.

const admin = base.admin;
const registrations = base.trusted as SignedRegistrationWire[];
const registrationOf = (name: string): SignedRegistrationWire => {
  const found = registrations.find((r) => r.body.name === name);
  if (found === undefined) throw new Error(`the seed approval-codes-recallable.json holds no registration of "${name}": the machines seeds are built from it`);
  return found;
};

// Fake key ids (32 hex characters, a visible pattern: not the id of any real key).
const THINKCENTRE: PeerEntry = {
  registration: registrationOf('thinkcentre'),
  keyId: '0123456789abcdef0123456789abcdef',
  aliases: ['tc'],
  reachableState: 'direct',
  reachable: 'directly reachable',
  receivesNotices: true,
  listHeldText: '',
};
const MAC_M2: PeerEntry = {
  registration: registrationOf('mac-m2'),
  keyId: 'fedcba9876543210fedcba9876543210',
  aliases: [],
  reachableState: 'unknown',
  reachable: 'not reachable now: documents go through the relay inbox',
  receivesNotices: false,
  listHeldText: '',
};

// The serial of the revocation of mac-m2 in `peer-revoked-earlier`.
const REVOKED_SERIAL = 3;

const state = (peers: PeerEntry[], plan: RevokePlan, revoked: MachinesState['revoked'] = []): MachinesState => ({
  admin: { ...admin },
  adminKeyFile: base.adminKeyFile,
  peers: peers.map((p) => ({ ...p, aliases: [...p.aliases] })),
  revoked,
  heldVersion: 1_795_800_000,
  plan,
});

export const MACHINES_SEED_NAMES = ['only-this-machine', 'two-trusted-peers', 'peer-revoked-earlier', 'revoke-delivered', 'revoke-partial', 'revoke-failed', 'relay-unreachable'] as const;

export type MachinesSeedName = (typeof MACHINES_SEED_NAMES)[number];

/** A fresh copy of the seed: the mock mutates nothing, but the state is never shared between two scenarios either. */
export function machinesSeed(name: MachinesSeedName): MachinesState {
  switch (name) {
    case 'only-this-machine':
      return state([], 'delivered');
    case 'two-trusted-peers':
      return state([THINKCENTRE, MAC_M2], 'delivered');
    case 'peer-revoked-earlier':
      return state([THINKCENTRE], 'delivered', [{ uuid: MAC_M2.registration.body.uuid, serial: REVOKED_SERIAL }]);
    case 'revoke-delivered':
      return state([THINKCENTRE, MAC_M2], 'delivered');
    case 'revoke-partial':
      return state([THINKCENTRE, MAC_M2], 'partial');
    case 'revoke-failed':
      return state([THINKCENTRE, MAC_M2], 'failed');
    case 'relay-unreachable':
      return state([THINKCENTRE, MAC_M2], 'relay-unreachable');
  }
}
