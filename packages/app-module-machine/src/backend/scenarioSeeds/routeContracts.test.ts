import type { SignedRegistration } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import type { ApproveContext } from '../../../../dsl-lib-machine/src/lib/approveFlow.js';
import type { DeliveryMachine as PageDeliveryMachine } from '../../../../dsl-lib-machine/src/lib/approvalResult.js';
import type { AdminLoginState } from '../../../../dsl-lib-machine/src/lib/adminLoginFlow.js';
import type { AdminLoginAnswer } from '../../../../machine-cli/src/adminLoginFromPage.js';
import type { ApproveDistributeAnswer } from '../../../../machine-cli/src/approveDistribute.js';
import type { DeliveryMachine } from '../../../../machine-cli/src/deliveryMachines.js';
import type { RetryDeliveryAnswer } from '../../../../machine-cli/src/deliveryRetry.js';
import type { RecordedApproval } from '../approvalCodes.js';
import type { CandidacyListView, SealedApprovalBody } from '../candidacies.js';
import type { TimelineStepRow as RealTimelineStepRow } from '../candidacyTimeline.js';
import type { ErrorBody as RealErrorBody } from '../errorBody.js';
import type {
  ApprovalCodeRequest,
  ApprovalReminder,
  ApproveContextAnswer,
  ApproveRequest,
  CandidacyRow,
  CandidacyView,
  DeliveryMachineWire,
  DistributeAnswer,
  RetryDeliveryRequest,
  ErrorBody,
  SignedRegistrationWire,
  TimelineStepRow,
} from '../../commons/routeContracts.js';

// The wire contracts of src/commons/routeContracts.ts are re-declared (they must not import a Node module). This file is the guard against drift: it is checked by
// `npm run typecheck`, not by the test runner. `Same<A, B>` is true when each type is assignable to the other; `Into<A, B>` when A is assignable to B (used where the
// wire type is deliberately looser than the real one: an opaque signed document, a union of codes read as text). A drift makes `Is<...>` a type error on that line.

type Is<T extends true> = T;
type Into<A, B> = [A] extends [B] ? true : false;
type Same<A, B> = Into<A, B> extends true ? Into<B, A> : false;

export type Checks = [
  Is<Same<CandidacyView, CandidacyListView>>,
  // `candidacyRow` of the backend index.ts is not exported: its return type is `CandidacyListView & {...}`; the row keys are also compared at runtime on the real route (seeds.test.ts).
  Is<Same<CandidacyRow, CandidacyListView & { ageText: string; bindingText: string; statusText: string; canDecide: boolean; canApprove: boolean }>>,
  Is<Same<TimelineStepRow, RealTimelineStepRow>>,
  Is<Same<ErrorBody, RealErrorBody>>,
  Is<Same<ApprovalReminder, Pick<RecordedApproval, 'uuid' | 'name' | 'code'> & { ageText: string }>>,
  Is<Same<ApprovalCodeRequest, Pick<RecordedApproval, 'uuid' | 'name' | 'code'>>>,
  Is<Same<ApproveRequest['approval'], SealedApprovalBody>>,
  Is<Same<SignedRegistrationWire, SignedRegistration>>,
  // The context the page consumes (dsl-lib-machine) is what the wire promises, and the wire is not looser except for the opaque list of notice recipients.
  Is<Into<ApproveContext, ApproveContextAnswer>>,
  Is<Into<Omit<ApproveContextAnswer, 'noticeRecipients'>, Omit<ApproveContext, 'noticeRecipients'>>>,
  Is<Into<DeliveryMachine, DeliveryMachineWire>>,
  Is<Into<PageDeliveryMachine, DeliveryMachineWire>>,
  Is<Into<DeliveryMachineWire, PageDeliveryMachine>>,
  Is<Into<Extract<ApproveDistributeAnswer, { ok: true }>, DistributeAnswer>>,
  // The retry answers the same shape as the delivery it finishes: the page reads one type for both.
  Is<Same<Extract<RetryDeliveryAnswer, { ok: true }>, Extract<ApproveDistributeAnswer, { ok: true }>>>,
  Is<Into<Extract<RetryDeliveryAnswer, { ok: true }>, DistributeAnswer>>,
  Is<Same<RetryDeliveryRequest, { uuid: string }>>,
  // The relay login started from the page: what the page reads is exactly what the daemon answers when it does not refuse (a refusal is an HTTP error).
  Is<Same<AdminLoginState, Extract<AdminLoginAnswer, { ok: true }>>>,
];

describe('route contracts', () => {
  it('are proved against the real types by `npm run typecheck` (this file has no runtime assertion of its own)', () => {
    const checks: Checks | undefined = undefined;
    expect(checks).toBeUndefined();
  });
});
