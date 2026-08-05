import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SignInPanel } from '../components/sign-in-panel';
import { SSO_OUTCOME_STATEMENTS } from '../lib/sso-source';

/**
 * The code step of a two-factor sign-in, as a *screen*.
 *
 * ## The bug this file exists to keep fixed
 *
 * `second-factor.test.ts` proves the endpoints: a password alone mints no session, the code step accepts
 * a valid code once, a reused code is refused, a recovery code is spent. Every one of those passed while
 * **two-factor sign-in was impossible to complete through the product**, because nothing rendered a
 * prompt for the code.
 *
 * `POST /api/auth/login` answers `200` with `{signedIn: false, secondFactorRequired: true, challenge}`
 * when 2FA is on — deliberately, so a correct password yields no cookie. The sign-in panel read any
 * `response.ok` as success and navigated to `/`, where there was no session; the reader was bounced back
 * to the sign-in screen with nothing said and no way forward. A green endpoint suite over an unreachable
 * flow is exactly the gap "finish the UI layer, not just the data layer" names, so the fix gets its own
 * file rather than a line inside the endpoint suite.
 *
 * ## Why static markup is enough here
 *
 * The panel is a client island and these are server renders, so the `fetch`-driven transition cannot be
 * exercised this way. It does not need to be: the *same state* is reachable from a prop —
 * `pendingChallenge` — because the OAuth and SAML callbacks hand the challenge back in the URL and
 * `/account` passes it down. Rendering with that prop set renders precisely the branch the password path
 * reaches, so what is asserted is the branch's existence and its content. The transition itself is one
 * `setChallenge` call in a handler this file's sibling asserts the endpoint contract of.
 */

const codeStep = (): string =>
  renderToStaticMarkup(<SignInPanel pendingChallenge="a-signed-challenge-value" />);

describe('the second-factor code step is reachable and renders a prompt', () => {
  it('renders a code field when a challenge is pending', () => {
    const markup = codeStep();

    expect(markup).toContain('name="code"');
    expect(markup).toContain('id="second-factor-code"');
  });

  it('offers `one-time-code` autocomplete, so a phone can fill it from its own notification', () => {
    expect(codeStep()).toContain('autoComplete="one-time-code"');
  });

  it('does not autofocus, because moving focus after a navigation loses a screen-reader their place', () => {
    // `jsx-a11y/no-autofocus` refuses it and the rule is right on this screen in particular: the code
    // step is reached by a page transition after an SSO round-trip.
    expect(codeStep()).not.toContain('autofocus');
  });

  it('says a recovery code works instead, which is the only place somebody would learn that', () => {
    const markup = codeStep().toLowerCase();

    expect(markup).toContain('recovery code');
  });

  it('offers a way back, so a wrong account is not a dead end', () => {
    expect(codeStep()).toContain('start again');
  });

  /**
   * The panel replaces itself rather than appending the code field below the password form.
   *
   * Two live forms of which only one can succeed is the shape that invites somebody to start over and
   * lose the challenge they are holding — and a first factor has already been proved, so re-offering the
   * three sign-in methods is offering to undo work.
   */
  it('replaces the sign-in form rather than showing both at once', () => {
    const markup = codeStep();

    expect(markup).not.toContain('name="email"');
    expect(markup).not.toContain('name="password"');
    expect(markup).not.toContain('how would you like to sign in');
  });

  it('shows the ordinary sign-in form when no challenge is pending', () => {
    // The other direction, so the branch cannot be entered by accident on a normal visit.
    const markup = renderToStaticMarkup(<SignInPanel />);

    expect(markup).toContain('name="email"');
    expect(markup).toContain('name="password"');
    expect(markup).not.toContain('id="second-factor-code"');
  });

  it('explains why a code is being asked for rather than only demanding one', () => {
    const markup = codeStep();

    expect(markup).toContain('one more step');
    // The prose says the password was accepted, which is the fact that stops this reading as a failure.
    expect(markup.toLowerCase()).toContain('password was right');
  });
});

describe('a federated sign-in that owes a code', () => {
  /**
   * The SSO and SAML callbacks route through this same prompt.
   *
   * Both redirect to `/account?sso=second-factor&challenge=…` rather than to the JSON code endpoint,
   * because the caller is a browser mid-navigation. That means there is one code prompt in the product
   * rather than one per sign-in method — and the sentence the page shows has to exist for the slug the
   * callbacks use, or the reader arrives at a form with no explanation.
   */
  it('has a stated sentence for the `second-factor` outcome the callbacks redirect with', () => {
    const statement = SSO_OUTCOME_STATEMENTS['second-factor'];

    expect(statement).toBeDefined();
    expect(statement?.toLowerCase()).toContain('two-factor');
    // It must say the provider *did* confirm them, or the reader reads the prompt as a rejection.
    expect(statement?.toLowerCase()).toContain('confirmed');
  });

  it('renders the same code prompt when the challenge arrived from a callback', () => {
    // Identical branch, different origin: the panel does not care which sign-in owed the code.
    expect(codeStep()).toContain('id="second-factor-code"');
  });
});
