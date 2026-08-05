import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEMO_OWNER_EMAIL,
  OWNER_EMAIL_ENV_VAR,
  OWNER_PASSWORD_ENV_VAR,
  ROLE_MATRIX,
  ownerConfigurationProblem,
  resolveOwnerCredentials,
} from '@compass/auth';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ReportDocument } from '../components/report-document';
import { SignInPanel } from '../components/sign-in-panel';
import { buildReportView } from '../lib/view-model';

import { freshnessComplete, storedBundle } from './helpers/report-fixture';

/**
 * How a person who has never seen this deployment gets in.
 *
 * The bootstrap provisions an owner seat with published demonstration credentials, and
 * `/account` prints them. That is only useful if somebody *arriving* at the product can
 * find it, and "arriving" does not mean "arriving at the page that shows the password" —
 * a reader lands on the report, or on an invitation link, or on a reset link whose token
 * has already been spent. So the claim this file pins is a property of the whole
 * unauthenticated surface rather than of one screen:
 *
 *   **every page reachable without a session either shows the demonstration credentials
 *   or links, in one hop, to the page that does.**
 *
 * Without this, the failure mode is silent and specific: somebody moves the footer link
 * out of `ReportDocument`, or adds a fourth unauthenticated screen, and the demo still
 * "works" for anyone who already knows to type `/account` — which is everybody who wrote
 * it and nobody who was handed it.
 *
 * The credentials themselves are asserted against the `@compass/auth` exports rather
 * than against string literals, so changing the published demonstration password cannot
 * leave this suite green while the sign-in panel offers the old one.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readWebFile = (...parts: string[]): string => readFileSync(join(WEB_ROOT, ...parts), 'utf8');

/**
 * Every surface a reader can reach with no cookie, and how each one discharges the duty.
 *
 * `showsCredentials` is the page that prints them. Everything else has to *link* to it.
 * Enumerated by hand rather than walked off the filesystem, because the interesting
 * question is whether a *new* unauthenticated screen was added and left off this list —
 * a walk would add it silently and assert nothing about it. `authz-matrix.test.ts` is
 * what makes the list checkable: it holds the set of publicly-readable routes, and the
 * assertion below diffs this list against that set.
 */
const UNAUTHENTICATED_PAGES: readonly {
  readonly route: string;
  readonly file: readonly string[];
  readonly showsCredentials: boolean;
  /**
   * The string that proves this surface reaches the credentials.
   *
   * Defaults to `href="/account"` — a link in rendered markup. Two surfaces discharge the duty
   * differently and say so here rather than being special-cased in the assertion below.
   */
  readonly reaches?: string;
}[] = [
  { route: '/account', file: ['app', 'account', 'page.tsx'], showsCredentials: true },
  /**
   * `/login` is an endpoint, not a screen — the short POST address published in
   * `.nous/demo_account.json`. It appears here because the matrix grants `public` a GET on it, and
   * this file's whole job is that every such surface has a route to the credentials. Its GET *is*
   * that route: a 303 to `/account`, which is the page that prints them.
   */
  { route: '/login', file: ['app', 'login', 'route.ts'], showsCredentials: false, reaches: "'/account'" },
  { route: '/', file: ['components', 'report-document.tsx'], showsCredentials: false },
  { route: '/goals', file: ['app', 'goals', 'page.tsx'], showsCredentials: false },
  { route: '/account/invite', file: ['app', 'account', 'invite', 'page.tsx'], showsCredentials: false },
  { route: '/account/reset', file: ['app', 'account', 'reset', 'page.tsx'], showsCredentials: false },
  /**
   * The deletion-undo landing page.
   *
   * Public and carrying no `demoOnlyPublic`, because it holds no organization data at all: it reads a
   * token from the query string, posts it, and prints the outcome. Somebody arriving here followed a
   * link from an email about their own account, so the way out that matters is `/account`, which it
   * names directly rather than by way of the report.
   */
  { route: '/account/deletion', file: ['app', 'account', 'deletion', 'page.tsx'], showsCredentials: false },
  /**
   * The archive and the two cross-cutting reads.
   *
   * `showsCredentials: false` for the same reason `/` is: a reader who arrives at last Tuesday's report has
   * what they came for, and a sign-in block on a document they can already read would be noise. Each of
   * these does carry a `/account` link — the assertion below is what holds them to it — so somebody who
   * needs a seat has one click to find out how.
   */
  { route: '/archive', file: ['app', 'archive', 'page.tsx'], showsCredentials: false },
  { route: '/archive/[reportId]', file: ['app', 'archive', '[reportId]', 'page.tsx'], showsCredentials: false },
  // The side-by-side diff. Two archived reports, so the same posture as the reports themselves: the
  // reviewer sent this link came to check a claim, not to sign in.
  { route: '/archive/diff', file: ['app', 'archive', 'diff', 'page.tsx'], showsCredentials: false },
  {
    route: '/archive/merged/[reportDate]',
    file: ['app', 'archive', 'merged', '[reportDate]', 'page.tsx'],
    showsCredentials: false,
  },
  { route: '/merged', file: ['app', 'merged', 'page.tsx'], showsCredentials: false },
  { route: '/weekly', file: ['app', 'weekly', 'page.tsx'], showsCredentials: false },
  /**
   * The public pricing page.
   *
   * Public in *every* tenant rather than only the demonstration one, unlike the report surfaces: it
   * carries no organizational data at all — it reads the plan table out of `@compass/billing` and
   * nothing else — so there is nothing for `demoOnlyPublic` to confine.
   *
   * It shows no credentials, so it has to offer a way to reach them. It originally linked only to
   * `/billing`, which is owner-only and answers a refusal to a reader with no session — this list is
   * what caught that, and the page now carries a `/account` link beside it.
   */
  { route: '/pricing', file: ['app', 'pricing', 'page.tsx'], showsCredentials: false },
  /**
   * The evidence page behind a claim.
   *
   * It joined this list when it gained a matrix entry at all: `beta-security-hardening` extended the
   * route enumeration to rendered screens and found `/artifact/[kind]/[artifactId]` had been serving
   * one organization's commits and tickets with no entry in `ROLE_MATRIX`. Public on the
   * demonstration tenant now, on the same terms as the report — a receipt is only useful if the
   * reader of the claim can open it.
   *
   * Discharges its duty the way `/goals` does, and for the same reason: it is a page you arrive at
   * *from* the report, by tapping an evidence marker, so its way out is back to `/` — whose footer
   * carries the account link. The proof points at the component rather than the page because the
   * page is a two-line shell around it.
   */
  {
    route: '/artifact/[kind]/[artifactId]',
    file: ['components', 'artifact-detail.tsx'],
    showsCredentials: false,
    reaches: 'href="/"',
  },
  /**
   * The published legal and trust documents.
   *
   * Public in *every* tenant rather than only the demonstration one, on the same terms as `/pricing`:
   * the content is a typed module in `@compass/trust` and nothing is read from a database, so there is
   * no tenant data for `demoOnlyPublic` to confine. A privacy policy that required a session would be
   * a document nobody could evaluate before signing up, which is the opposite of publishing one.
   *
   * These are the surfaces most likely to be a stranger's *first* page — a link in a procurement
   * thread, or a search result — so a way in matters here more than anywhere else on this list. Each
   * carries a footer naming `/account` directly rather than routing through the report.
   */
  { route: '/legal', file: ['app', 'legal', 'page.tsx'], showsCredentials: false },
  /**
   * `/legal/[slug]` renders whichever of the five documents the slug names, and its footer lives in
   * `PolicyPage` — the page itself is a shell that resolves the slug and hands over. So the proof
   * points at the component, exactly as `/artifact/[kind]/[artifactId]` does, because that is where
   * the link somebody would delete actually is.
   */
  { route: '/legal/[slug]', file: ['components', 'policy-document.tsx'], showsCredentials: false },
  {
    route: '/trust/subprocessors',
    file: ['app', 'trust', 'subprocessors', 'page.tsx'],
    showsCredentials: false,
  },
];

describe('the published demonstration credentials are shown where they are needed', () => {
  const panel = renderToStaticMarkup(
    <SignInPanel generatedOwnerEmail={DEMO_OWNER_EMAIL} />,
  );

  it('prints the address, as rendered markup', () => {
    // The rendered output, not the source: a block behind a condition that never holds
    // would pass a source scan and show a reader nothing.
    expect(panel).toContain(DEMO_OWNER_EMAIL);
  });

  /**
   * The password is *not* here, and that is the assertion.
   *
   * There used to be a `DEMO_OWNER_PASSWORD` constant to print. Removing it from shipped source
   * removed the only way this process could know an unconfigured deployment's password: the
   * worker mints it on the boot that creates the seat, Argon2id-hashes it into the database, and
   * prints it once. A page that showed a password now could only be showing a wrong one.
   */
  it('does not print a password, because this process cannot know it', () => {
    expect(panel).not.toContain('fill the form with them');
    // Where to find it instead — the two places it actually exists.
    expect(panel).toContain('.nous/demo_account.json');
    expect(panel).toContain('boot log');
    expect(panel).toContain('only a hash');
  });

  it('offers to fill in the address, which is the half it does have', () => {
    expect(panel).toContain('fill in that address');
  });

  it('says out loud that a real deployment must configure its own', () => {
    // Honest degradation: a generated password is a stated fact about this deployment, not
    // a convenience that quietly becomes a production credential.
    expect(panel).toContain(OWNER_EMAIL_ENV_VAR);
    expect(panel).toContain(OWNER_PASSWORD_ENV_VAR);
  });

  it('shows the address the bootstrap actually provisions', () => {
    // The other end of the same wire, for the half that is still knowable. The password is
    // supplied rather than resolved, because an unconfigured environment has none — asserted
    // directly in `packages/auth/tests/owner-bootstrap.test.ts`.
    const provisioned = resolveOwnerCredentials({}, 'a-supplied-first-run-password');

    expect(provisioned.email).toBe(DEMO_OWNER_EMAIL);
    expect(provisioned.isDefault).toBe(true);
  });

  it('prints nothing at all when the deployment has configured its own owner', () => {
    // The inverse, and the one that matters once Compass holds real data: a deployment
    // with a configured owner must not render this block for it.
    const configured = renderToStaticMarkup(<SignInPanel generatedOwnerEmail={null} />);

    expect(configured).not.toContain(DEMO_OWNER_EMAIL);
    expect(configured).not.toContain('this deployment configured no owner');
    expect(configured).not.toContain('fill in that address');
    // And the form is still there, so the page is a sign-in page either way. The posted
    // endpoint lives in the submit handler rather than in a form `action`, so what is
    // asserted here is the rendered form: the fields and the button.
    expect(configured).toContain('name="email"');
    expect(configured).toContain('name="password"');
    expect(configured).toContain('>Sign in<');
  });

  it('is wired to the deployment’s own answer rather than to a hardcoded true', () => {
    // `/account` decides whether to pass the address down by asking
    // `ownerCredentialsAreDefault()`, which reads the environment. A page that passed it
    // unconditionally would name a configured deployment's owner address to anybody.
    const account = readWebFile('app', 'account', 'page.tsx');

    expect(account).toContain('ownerCredentialsAreDefault()');
    expect(account).toContain('DEMO_OWNER_EMAIL');
    // And it cannot have reacquired a password to print.
    expect(account).not.toContain('DEMO_OWNER_PASSWORD');
  });
});

/**
 * A half-configured owner environment, on the one screen that offers credentials.
 *
 * `bootstrapOwner` refuses to provision on it, so there is no seat — and the credentials the
 * resolver returns are the *configured* address paired with the published password, which is
 * exactly the pairing the guard exists to prevent. Offering `owner@compass.demo` here would
 * name an address that does not exist and read as a broken product rather than a
 * misconfigured deployment.
 */
describe('a half-configured owner environment is stated, not papered over', () => {
  const halfConfigured = { [OWNER_EMAIL_ENV_VAR]: 'owner@acme.example' };
  const configurationProblem = ownerConfigurationProblem(halfConfigured);

  it('has a problem to state, so this suite cannot pass vacuously', () => {
    expect(configurationProblem).not.toBeNull();
    expect(configurationProblem).toContain(OWNER_PASSWORD_ENV_VAR);
  });

  it('renders the sentence, naming the variable that is missing', () => {
    const panel = renderToStaticMarkup(
      <SignInPanel configurationProblem={configurationProblem} generatedOwnerEmail={null} />,
    );

    expect(panel).toContain('this deployment has no owner seat');
    expect(panel).toContain(OWNER_PASSWORD_ENV_VAR);
  });

  it('does not offer the demonstration credentials, which would not open anything', () => {
    const panel = renderToStaticMarkup(
      <SignInPanel configurationProblem={configurationProblem} generatedOwnerEmail={null} />,
    );

        expect(panel).not.toContain(DEMO_OWNER_EMAIL);
    expect(panel).not.toContain('fill the form with them');
  });

  it('never echoes a configured password into the page', () => {
    const secret = 'the-operators-own-configured-passphrase';
    const panel = renderToStaticMarkup(
      <SignInPanel
        configurationProblem={ownerConfigurationProblem({ [OWNER_PASSWORD_ENV_VAR]: secret })}
        generatedOwnerEmail={null}
      />,
    );

    expect(panel).not.toContain(secret);
  });

  it('leaves the form in place, so the screen is still a sign-in screen', () => {
    const panel = renderToStaticMarkup(
      <SignInPanel configurationProblem={configurationProblem} generatedOwnerEmail={null} />,
    );

    expect(panel).toContain('name="email"');
    expect(panel).toContain('>Sign in<');
  });

  it('is wired from the page, and gates the credentials on the same answer', () => {
    // Both halves in the source: the panel is told about the problem, and the credential
    // block is conditional on there not being one. Passing the problem down while still
    // printing the credentials would state the fact and contradict it in the next paragraph.
    const account = readWebFile('app', 'account', 'page.tsx');

    expect(account).toContain('configurationProblem={ownerConfigurationProblem()}');
    expect(account).toContain('ownerConfigurationProblem() === null && ownerCredentialsAreDefault()');
  });

  it('says nothing at all when the environment is whole', () => {
    // The demonstration deployment and a fully configured one both resolve to `null`, so
    // neither renders this block. Otherwise every zero-config reader would be told their
    // deployment has no owner seat, which is the opposite of true.
    expect(ownerConfigurationProblem({})).toBeNull();

    const whole = renderToStaticMarkup(<SignInPanel generatedOwnerEmail={null} />);
    expect(whole).not.toContain('this deployment has no owner seat');
  });
});

describe('every unauthenticated entry point reaches the credentials in one hop', () => {
  it('links to /account from the report itself, in rendered markup', () => {
    // `/` is where a reader actually lands — the zero-config promise puts a report
    // there with no session. The link out of it is asserted against the markup the
    // real component produces, so moving it into a component that is never rendered
    // fails here.
    const report = renderToStaticMarkup(
      <ReportDocument view={buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() })} />,
    );

    expect(report).toContain('href="/account"');
    expect(report).toContain('Account and sessions');
  });

  it.each(UNAUTHENTICATED_PAGES.filter((page) => !page.showsCredentials).map((page) => [page.route, page] as const))(
    '%s offers a route to the sign-in page',
    (route, page) => {
      const source = readWebFile(...page.file);

      // `/goals` is the one that reaches `/account` via the report rather than
      // directly: it is a screen you arrive at *from* the report, and its own link
      // back is to `/`, whose footer carries the account link asserted above. Any
      // other page must name `/account` itself, unless it declared its own proof above.
      const expected = page.reaches ?? (route === '/goals' ? 'href="/"' : 'href="/account"');

      expect(
        source.includes(expected),
        `${route} is readable with no session but offers no way to reach the credentials — a reader who lands here is stuck`,
      ).toBe(true);
    },
  );

  it('covers the invitation and reset forms, not only their missing-token states', () => {
    // Both pages render `TokenForm` when a token *is* present, which is the common
    // case — the missing-token branch is the rare one. The form carries its own way
    // out, so the two branches do not disagree about whether you are trapped.
    const form = readWebFile('components', 'token-form.tsx');

    expect(form).toContain('href="/account"');
  });

  it('names every publicly-readable page, so a new one cannot be left off this list', () => {
    /**
     * The guard on the list above.
     *
     * `ROLE_MATRIX` already knows which routes are readable without a session — the
     * authz suite holds it to that. Rather than trusting this file's hand-written
     * enumeration, the two are diffed: a sixth public page added to the matrix fails
     * here until somebody has decided how a reader arriving at it gets in.
     *
     * `/` appears in the matrix and is served by `app/page.tsx`, but the link under
     * test lives in `ReportDocument`, which is why the list points at the component.
     */
    const publicPages = ROLE_MATRIX.filter(
      (rule) => !rule.route.startsWith('/api/') && rule.allow.GET?.includes('public') === true,
    ).map((rule) => rule.route);
    const listed = UNAUTHENTICATED_PAGES.map((page) => page.route);

    expect(
      [...listed].sort(),
      'a page is publicly readable but this file has not decided how a reader arriving at it finds the credentials',
    ).toEqual([...publicPages].sort());
    // Exactly one of them is the page that prints the credentials.
    expect(UNAUTHENTICATED_PAGES.filter((page) => page.showsCredentials).map((page) => page.route)).toEqual([
      '/account',
    ]);
  });
});
