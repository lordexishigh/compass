import { ROLE_CAPABILITIES, TOKEN_TTL_LABEL } from '@compass/auth';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SeatManager, type SeatView } from '../components/seat-manager';

/**
 * What `/settings/members` actually lists.
 *
 * The seat *lifecycle* is proved in `packages/auth/tests/seats.test.ts` against a real
 * database — invite, resend, revoke, role change, the last-owner refusal and the expiry
 * window all live there, where they are enforced. Asserting them again through markup
 * would be theatre.
 *
 * This suite covers the half that file cannot see: that the screen a manager opens
 * *offers* each of those acts and states each of those facts. A lifecycle that works and a
 * page that never exposes it is the failure mode this product has already shipped once —
 * an endpoint reachable only by hand-crafting a request is not a feature.
 *
 * So every assertion here is about presence in the rendered tree, and the two constants it
 * checks against (`TOKEN_TTL_LABEL`, `ROLE_CAPABILITIES`) are imported rather than
 * restated, for the same reason the component takes the lifetime as a prop.
 */

const PRIYA: SeatView = {
  membershipId: 'm-owner',
  email: 'priya@example.com',
  displayName: 'Priya Raman',
  role: 'owner',
  status: 'active',
  hasPassword: true,
  teamKeys: ['platform'],
  invitedAtLabel: '2026-07-01',
  lastActiveLabel: 'active today',
  isYou: true,
};

/** An accepted seat that has not been back in a while — the interesting last-active case. */
const MARCUS: SeatView = {
  membershipId: 'm-manager',
  email: 'marcus@example.com',
  displayName: 'Marcus Hale',
  role: 'manager',
  status: 'active',
  hasPassword: true,
  teamKeys: ['checkout'],
  invitedAtLabel: '2026-07-04',
  lastActiveLabel: 'active 12 days ago',
  isYou: false,
};

/** Invited, never accepted. Displayed by address, because there is no name yet. */
const PENDING: SeatView = {
  membershipId: 'm-pending',
  email: 'dana@example.com',
  displayName: 'dana@example.com',
  role: 'member',
  status: 'pending',
  hasPassword: false,
  teamKeys: [],
  invitedAtLabel: '2026-07-30',
  lastActiveLabel: 'never signed in',
  isYou: false,
};

const asOwner = (seats: readonly SeatView[]): string =>
  renderToStaticMarkup(
    <SeatManager
      seats={seats}
      canManage
      knownTeamKeys={['platform', 'checkout']}
      roleCapabilities={ROLE_CAPABILITIES}
      inviteLifetimeLabel={TOKEN_TTL_LABEL.invite}
    />,
  );

describe('the members screen lists pending and active seats together', () => {
  const markup = asOwner([PRIYA, MARCUS, PENDING]);

  it('shows both accepted seats and invitations that have not landed', () => {
    for (const seat of [PRIYA, MARCUS, PENDING]) {
      expect(markup, `${seat.email} is not on the screen`).toContain(seat.email);
    }
  });

  it('says of a pending seat that it has not been accepted, and when it was invited', () => {
    expect(markup).toContain('not yet accepted');
    expect(markup).toContain(PENDING.invitedAtLabel);
  });

  it('states each seat’s role and the teams it may read', () => {
    expect(markup).toContain('teams checkout');
    // An owner is unscoped, and the screen says why rather than printing an empty list.
    expect(markup).toContain('every team, because owners are unscoped');
    // A pending member with no scope reads nothing, which is stated rather than blank.
    expect(markup).toContain('no team scoped, so no report is readable');
  });
});

describe('the members screen states last-active', () => {
  it('carries the clause for every seat that has accepted', () => {
    const markup = asOwner([PRIYA, MARCUS]);
    expect(markup).toContain('active today');
    expect(markup).toContain('active 12 days ago');
  });

  /**
   * A pending seat gets no last-active clause, and that is a decision rather than a gap.
   *
   * It has never signed in by definition, so 'never signed in' beside 'not yet accepted'
   * would be the same fact twice in one sentence. The value is still carried on the view —
   * the page computes it for every seat — so this asserts the *rendering* choice, which is
   * the thing that could regress without anybody noticing.
   */
  it('does not repeat the fact on a seat that has not accepted yet', () => {
    expect(asOwner([PENDING])).not.toContain('never signed in');
  });
});

describe('the members screen offers every act the lifecycle supports', () => {
  const markup = asOwner([PRIYA, MARCUS, PENDING]);

  it('offers a role control for each seat that still has one', () => {
    // One per non-revoked seat, named by address so a screen reader hears which.
    for (const seat of [PRIYA, MARCUS, PENDING]) {
      expect(markup, `no role control for ${seat.email}`).toContain(`Role for ${seat.email}`);
    }
  });

  it('offers resend and revoke on a pending invitation, and removal on an accepted seat', () => {
    expect(markup).toContain('resend invitation');
    expect(markup).toContain('revoke invitation');
    expect(markup).toContain('remove seat');
  });

  it('offers the invitation form, stating the real window from the token constant', () => {
    expect(markup).toContain('Send invitation');
    expect(markup).toContain(`expires in ${TOKEN_TTL_LABEL.invite}`);
  });

  /**
   * A manager reads this list and may not act on it.
   *
   * The matrix admits owner *and* manager to the route, so the read-only rendering is a
   * real screen somebody meets rather than a defensive branch — and a manager who was
   * shown the controls and refused on click would be worse than one told plainly.
   */
  it('offers a manager none of them, and says why', () => {
    const readOnly = renderToStaticMarkup(
      <SeatManager
        seats={[PRIYA, PENDING]}
        canManage={false}
        knownTeamKeys={['platform']}
        roleCapabilities={ROLE_CAPABILITIES}
        inviteLifetimeLabel={TOKEN_TTL_LABEL.invite}
      />,
    );

    expect(readOnly).toContain(PRIYA.email);
    for (const action of ['resend invitation', 'revoke invitation', 'remove seat', 'Send invitation']) {
      expect(readOnly, `a manager is being offered "${action}"`).not.toContain(action);
    }
  });
});
