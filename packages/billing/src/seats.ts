import { planById, type Plan, type PlanId } from './plans.js';

/**
 * Seats, and the one change Compass refuses to make.
 *
 * ## Why a downgrade is blocked rather than silently trimmed
 *
 * Criterion 003: a downgrade below the current seat count must be **blocked**, naming which seats
 * to remove. Both halves matter, and the second is the reason for the first.
 *
 * Compass could accept the downgrade and drop the excess seats itself. It must not: the seats are
 * *people*, choosing which colleague loses access is a decision only the owner can make, and
 * discovering on Monday that Compass picked three is not a recoverable surprise. So the change is
 * refused and the refusal is actionable — it says how many must go and lists the candidates in the
 * order Compass would suggest, which is newest-first among the least privileged.
 *
 * The suggestion is explicitly *not* an instruction and never acts on its own. It exists so the
 * owner has somewhere to start rather than a bare number.
 */

/** One seat, as this module needs to see it. Structural, so `@compass/auth` stays downstream. */
export interface SeatSummary {
  readonly membershipId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly role: 'owner' | 'manager' | 'member' | 'viewer';
  readonly status: 'active' | 'pending' | 'revoked';
  /** When the seat was invited, as epoch millis. Ties break on `membershipId`. */
  readonly invitedAtMillis: number;
}

/**
 * Seats that count against the allowance.
 *
 * **Pending invitations count.** An invitation is a seat that will be occupied the moment somebody
 * clicks a link, so excluding it would let an owner buy four seats, invite twelve, and have the
 * allowance exceeded by people arriving rather than by any billable act. Revoked seats do not
 * count — that is what revoking is.
 */
export const seatIsBillable = (seat: SeatSummary): boolean =>
  seat.status === 'active' || seat.status === 'pending';

export const billableSeatCount = (seats: readonly SeatSummary[]): number =>
  seats.filter(seatIsBillable).length;

/**
 * The order Compass suggests removing seats in: least privileged first, then newest first.
 *
 * Viewers before members before managers, and an owner is never suggested at all — removing the
 * last owner is already refused a layer down by `LastOwnerError`, and suggesting an owner here
 * would propose a change that cannot be made. Newest-first within a role because the most recently
 * invited seat is the one least likely to be relied on.
 */
const REMOVAL_PRIORITY: Readonly<Record<SeatSummary['role'], number>> = {
  viewer: 0,
  member: 1,
  manager: 2,
  owner: 3,
};

export function removalCandidates(seats: readonly SeatSummary[]): readonly SeatSummary[] {
  return seats
    .filter(seatIsBillable)
    .filter((seat) => seat.role !== 'owner')
    .slice()
    .sort((left, right) => {
      const byRole = REMOVAL_PRIORITY[left.role] - REMOVAL_PRIORITY[right.role];
      if (byRole !== 0) return byRole;
      const byAge = right.invitedAtMillis - left.invitedAtMillis;
      if (byAge !== 0) return byAge;
      // Total and deterministic, so the same roster always yields the same suggestion and a test
      // is not asserting against insertion order.
      return left.membershipId < right.membershipId ? -1 : left.membershipId > right.membershipId ? 1 : 0;
    });
}

export interface PlanChangeAllowed {
  readonly allowed: true;
  readonly plan: Plan;
  readonly seatCount: number;
}

export interface PlanChangeBlocked {
  readonly allowed: false;
  readonly plan: Plan;
  readonly seatCount: number;
  /** How many seats must be removed before this plan can be selected. */
  readonly excessSeats: number;
  /** One sentence naming the number, for the banner. */
  readonly reason: string;
  /** Suggested seats to remove, longest-standing last. Never acted on automatically. */
  readonly suggestedRemovals: readonly SeatSummary[];
}

export type PlanChangeVerdict = PlanChangeAllowed | PlanChangeBlocked;

const describeSeat = (seat: SeatSummary): string =>
  seat.displayName === null || seat.displayName.trim().length === 0
    ? `${seat.email} (${seat.role})`
    : `${seat.displayName} <${seat.email}> (${seat.role})`;

/**
 * Whether the organization may move to `targetPlanId` with the seats it currently has.
 *
 * Returns a verdict rather than throwing, because the caller is a form handler that has to render
 * the refusal — and because "may I" is a question the billing page asks *before* the owner presses
 * anything, so the plan card can be shown as unavailable with its reason attached.
 */
export function planChangeVerdict(input: {
  readonly targetPlanId: PlanId;
  readonly seats: readonly SeatSummary[];
}): PlanChangeVerdict {
  const plan = planById(input.targetPlanId);
  const seatCount = billableSeatCount(input.seats);

  if (plan.maxSeats === null || seatCount <= plan.maxSeats) {
    return { allowed: true, plan, seatCount };
  }

  const excessSeats = seatCount - plan.maxSeats;
  const suggestedRemovals = removalCandidates(input.seats).slice(0, excessSeats);

  return {
    allowed: false,
    plan,
    seatCount,
    excessSeats,
    reason:
      `${plan.name} covers ${plan.maxSeats} seats and this organization has ${seatCount}, ` +
      `counting pending invitations. Remove ${excessSeats} ${excessSeats === 1 ? 'seat' : 'seats'} ` +
      `before moving to ${plan.name}.` +
      (suggestedRemovals.length === 0
        ? ' Every remaining seat is an owner, so change one to a manager first.'
        : ` Compass would start with ${suggestedRemovals.map(describeSeat).join(', ')} — ` +
          'your choice, not ours; nothing is removed until you remove it.'),
    suggestedRemovals,
  };
}

/**
 * Whether a seat may be *added* on the current plan.
 *
 * The mirror of the downgrade rule, and the reason it is here rather than in `@compass/auth`: the
 * plan ceiling is a billing fact, and `inviteSeat` should not have to know what a plan is. The auth
 * layer asks this and reports the refusal.
 */
export function seatAdditionVerdict(input: {
  readonly planId: PlanId;
  readonly seats: readonly SeatSummary[];
  readonly adding: number;
}): { readonly allowed: boolean; readonly reason: string | null } {
  const plan = planById(input.planId);
  if (plan.maxSeats === null) return { allowed: true, reason: null };

  const after = billableSeatCount(input.seats) + Math.max(0, Math.trunc(input.adding));
  if (after <= plan.maxSeats) return { allowed: true, reason: null };

  return {
    allowed: false,
    reason:
      `${plan.name} covers ${plan.maxSeats} seats and this would take the organization to ${after}, ` +
      'counting pending invitations. Move to a larger plan on the billing page first.',
  };
}
