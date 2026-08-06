import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MATRIX_ROUTES, authorize, findRouteRule, isPublicRoute } from '@compass/auth';
import { ERROR_REPORTING_CONSENTS, PRIVACY_DEFAULTS } from '@compass/db';
import { describe, expect, it } from 'vitest';

import { buildReportView } from '../lib/view-model';

import { freshnessComplete, storedBundle } from './helpers/report-fixture';

/**
 * The privacy surfaces, at the web edge.
 *
 * Three claims are proved here, and the third is the one that keeps this product from becoming
 * the thing it exists not to be:
 *
 *  1. A withdrawn name does not reach a page, and everything else on it does.
 *  2. The two screens are reachable by exactly the principals the criteria name — `/me` by any
 *     seat with no approval, `/privacy` by owners and managers.
 *  3. The transparency page contains no ranking, no comparison and no score. Asserted as a scan
 *     over its own source, because the failure mode is somebody adding a helpful-looking
 *     "compared to the team average" line in six months, and no rendering test would object.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 002: a withdrawn name does not reach a rendered page
// ---------------------------------------------------------------------------

/** Every person named anywhere in the stored fixture, so the test redacts a real one. */
function namesInFixture(): readonly string[] {
  const bundle = storedBundle();
  const text = bundle.sections
    .flatMap((section) => [section.prose, ...section.items.flatMap((item) => [item.headline, item.detail])])
    .join('\n');

  // The fixture's roster. Matched rather than hard-coded so a fixture edit cannot make this
  // test pass by testing nothing.
  return ['Priya Raman', 'Marcus Hale'].filter((name) => text.includes(name));
}

describe('a name withdrawn after a report was written', () => {
  it('is present in the fixture to begin with, so the assertion below is not vacuous', () => {
    expect(namesInFixture().length).toBeGreaterThan(0);
  });

  it('renders as "a former team member" everywhere it appeared', () => {
    const withdrawn = namesInFixture();

    const view = buildReportView({
      bundle: storedBundle(),
      freshness: freshnessComplete(),
      withdrawnNames: withdrawn,
    });

    const rendered = JSON.stringify(view);

    for (const name of withdrawn) {
      expect(rendered, `${name} still appears on the page`).not.toContain(name);
    }
    expect(rendered).toContain('former team member');
  });

  it('keeps every ticket key, pull request number and count intact', () => {
    const withdrawn = namesInFixture();

    const before = buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() });
    const after = buildReportView({
      bundle: storedBundle(),
      freshness: freshnessComplete(),
      withdrawnNames: withdrawn,
    });

    // Evidence labels, ages and stable ids are the report's receipts and its identity. A
    // withdrawal that took any of them would turn "stop printing my name" into "delete a day
    // of the team's evidence" — and would orphan every dismissal keyed on the stable id.
    const receipts = (view: typeof before) =>
      view.sections.flatMap((section) =>
        section.items.map((item) => ({
          stableId: item.stableId,
          ageDays: item.ageDays,
          evidence: item.evidence.map((reference) => reference.label),
        })),
      );

    expect(receipts(after)).toEqual(receipts(before));
  });

  it('changes nothing at all when no name is withdrawn', () => {
    const untouched = buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() });
    const explicitlyEmpty = buildReportView({
      bundle: storedBundle(),
      freshness: freshnessComplete(),
      withdrawnNames: [],
    });

    expect(explicitlyEmpty).toEqual(untouched);
  });
});

// ---------------------------------------------------------------------------
// 004: the transparency page needs no approval, and grades nobody
// ---------------------------------------------------------------------------

describe('/me is reachable by any seat, with no approval', () => {
  it('is in the matrix', () => {
    expect(MATRIX_ROUTES).toContain('/me');
  });

  it('admits every role', () => {
    for (const principal of ['owner', 'manager', 'member', 'viewer'] as const) {
      const decision = authorize({ route: '/me', action: 'GET', principal, seatActive: true });
      expect(decision.allowed, `${principal} cannot open their own transparency page`).toBe(true);
    }
  });

  it('is not public, because the answer is the reader’s own session', () => {
    const rule = findRouteRule('/me');
    expect(rule).not.toBeNull();
    expect(isPublicRoute(rule!)).toBe(false);
    expect(authorize({ route: '/me', action: 'GET', principal: 'public' }).allowed).toBe(false);
  });

  it('is read-only: no verb but GET is served', () => {
    for (const action of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      const decision = authorize({ route: '/me', action, principal: 'owner', seatActive: true });
      expect(decision.allowed, `${action} /me is served`).toBe(false);
    }
  });
});

describe('a member can actually get to their own page and act on it', () => {
  /**
   * The gap this closes, stated because the permission alone did not close it.
   *
   * `/me` and `/api/privacy/deletion` both admit every seat, and for a while the only link to
   * either was on `/privacy` — a screen a member's role cannot open. A permission nobody can
   * reach is not self-serve, and the criterion is about the *absence of an admin step*, not
   * about the matrix row. So the report footer carries both links, and this test is what stops
   * somebody tidying them back into the settings screen.
   */
  const reportDocument = readFileSync(join(WEB_ROOT, 'components', 'report-document.tsx'), 'utf8');
  const mePage = readFileSync(join(WEB_ROOT, 'app', 'me', 'page.tsx'), 'utf8');

  it('links to the transparency page from the report every seat can read', () => {
    expect(reportDocument).toContain('href="/me"');
  });

  it('links to the privacy screen from there too', () => {
    expect(reportDocument).toContain('href="/privacy"');
  });

  it('puts the account-deletion control on the page a member can open', () => {
    // Not only a link to a screen that would refuse them: the control itself.
    expect(mePage).toContain('DeletionControls');
    expect(mePage).toContain('canDeleteOrganization={false}');
  });

  it('does not offer a member the owner-only export as a button that would answer 403', () => {
    // Offered conditionally on the principal. A control that refuses when pressed reads as the
    // product being broken rather than as the permission it is.
    expect(mePage).toContain("canExport={access.principal === 'owner'}");
  });
});

describe('the transparency page contains no ranking, comparison or score', () => {
  const source = readFileSync(join(WEB_ROOT, 'app', 'me', 'page.tsx'), 'utf8');

  /**
   * The vocabulary a productivity dashboard is written in.
   *
   * A scan rather than a rendering assertion, because the failure this guards against is not a
   * bug — it is a well-meaning addition. Somebody will eventually think a percentile would be
   * useful context, and the only thing that will object is a test that names the words.
   */
  const FORBIDDEN = [
    'percentile',
    'ranking',
    'rank ',
    'leaderboard',
    'score',
    'compared to',
    'compared with',
    'team average',
    'above average',
    'below average',
    'top performer',
    'productivity',
  ];

  /**
   * Sentences, roughly. Good enough to decide whether a word sits in a denial or a claim.
   *
   * A flat "the file must not contain the word `score`" is the obvious rule and it is the wrong
   * one: the page's own disclaimer says "no score", and a test that forbade the word outright
   * would force the disclaimer to be deleted in order to pass — which would remove the very
   * sentence a reader needs. So the rule is that each of these words may appear **only** inside
   * a negated sentence.
   */
  const sentences = source.split(/(?<=[.!?])\s+|\n/u);
  const NEGATION = /\b(no|not|never|without|neither|nor|forbidden|refuse[sd]?)\b/iu;

  it.each(FORBIDDEN)('uses "%s" only to say the page does not do it', (phrase) => {
    const claiming = sentences.filter(
      (sentence) => sentence.toLowerCase().includes(phrase.toLowerCase()) && !NEGATION.test(sentence),
    );

    expect(
      claiming,
      `these lines use "${phrase}" as a claim rather than a denial. The transparency page grades nobody: ` +
        'a ranking, a comparison or a score here would make it the surveillance product Compass exists not to be.',
    ).toEqual([]);
  });

  it('finds the denials it is scanning, so the rule above cannot pass on an empty file', () => {
    const denials = sentences.filter(
      (sentence) => NEGATION.test(sentence) && /ranking|score|comparison/iu.test(sentence),
    );
    expect(denials.length).toBeGreaterThan(0);
  });

  it('says outright that it is not a report card', () => {
    // The absence of a score is not self-explanatory. A reader arriving anxious needs the page
    // to say what it is *not*, in words, before they trust what it is.
    expect(source).toContain('no ranking on this page');
    expect(source).toContain('not a report card');
  });

  it('states plainly when Compass holds nothing about somebody, rather than showing an empty page', () => {
    // An empty list reads as "nothing is held about you", which may be false — the honest answer
    // is that the account was never connected to anybody on the roster.
    expect(source).toContain('has not connected your account to anybody on the roster');
  });
});

// ---------------------------------------------------------------------------
// 001 / 003: who may change what
// ---------------------------------------------------------------------------

describe('the privacy screen and its routes', () => {
  it('lets a manager read the screen and turn a channel off, and nothing more', () => {
    expect(authorize({ route: '/privacy', action: 'GET', principal: 'manager', seatActive: true }).allowed).toBe(
      true,
    );
    expect(
      authorize({ route: '/api/privacy/channels', action: 'PATCH', principal: 'manager', seatActive: true }).allowed,
    ).toBe(true);
    // A retention window is the organization's posture, and the export is the whole of its data.
    expect(
      authorize({ route: '/api/privacy/settings', action: 'PATCH', principal: 'manager', seatActive: true }).allowed,
    ).toBe(false);
    expect(
      authorize({ route: '/api/privacy/export', action: 'GET', principal: 'manager', seatActive: true }).allowed,
    ).toBe(false);
  });

  it('refuses a member and a viewer the screen entirely', () => {
    for (const principal of ['member', 'viewer'] as const) {
      expect(authorize({ route: '/privacy', action: 'GET', principal, seatActive: true }).allowed).toBe(false);
    }
  });

  it('lets every seat ask to delete their own account', () => {
    // The route is `EVERY_SEAT` and the *subject* is never read from the body, so a seat can only
    // ever delete their own. `deletion/route.ts` refuses `organization` to anyone but an owner.
    for (const principal of ['owner', 'manager', 'member', 'viewer'] as const) {
      expect(
        authorize({ route: '/api/privacy/deletion', action: 'POST', principal, seatActive: true }).allowed,
        `${principal} cannot delete their own account`,
      ).toBe(true);
    }
  });

  it('lets the undo link work with no session at all', () => {
    // It has to: a pending deletion may be exactly why the account holder cannot sign in.
    expect(authorize({ route: '/api/privacy/deletion/undo', action: 'POST', principal: 'public' }).allowed).toBe(
      true,
    );
    // And it is not `demoOnlyPublic`, because it holds no organization data — a token in, a
    // sentence out.
    expect(findRouteRule('/api/privacy/deletion/undo')?.demoOnlyPublic).toBeUndefined();
  });

  it('does not read an undo token over GET, so a link scanner cannot cancel a deletion', () => {
    expect(authorize({ route: '/api/privacy/deletion/undo', action: 'GET', principal: 'public' }).allowed).toBe(
      false,
    );
  });
});

/**
 * The error-reporting consent, from the stored value through to what the reader sees.
 *
 * Three claims the feature rests on, none of which any other test would notice breaking:
 * the answer lives in the organization's privacy row rather than in a cookie of its own, only an
 * owner may give it, and `unset` is a state the API cannot be talked into writing.
 */
describe('the error-reporting consent', () => {
  it('is the organization’s posture, so only an owner may answer', () => {
    // It decides whether a third party receives anything at all — the same class of decision as a
    // retention window, and gated by the same route.
    expect(
      authorize({ route: '/api/privacy/settings', action: 'PATCH', principal: 'owner', seatActive: true }).allowed,
    ).toBe(true);
    for (const principal of ['manager', 'member', 'viewer', 'public'] as const) {
      expect(
        authorize({ route: '/api/privacy/settings', action: 'PATCH', principal, seatActive: true }).allowed,
        `${principal} must not decide for the organization`,
      ).toBe(false);
    }
  });

  it('has no route of its own, because the notice writes through the privacy settings', () => {
    /**
     * The design constraint stated as an assertion. A consent banner's usual shape is its own
     * endpoint writing its own cookie, which is how a product ends up with two places that
     * disagree about what the user chose. There is exactly one writer here.
     */
    expect(findRouteRule('/api/privacy/consent')).toBeNull();
    expect(findRouteRule('/api/consent')).toBeNull();
  });

  it('defaults to unset, so a deployment reports nothing until somebody answers', () => {
    expect(PRIVACY_DEFAULTS.errorReportingConsent).toBe('unset');
    // And the vocabulary keeps "not asked" distinct from "said no", which is what the notice keys
    // on: collapse them and it either never appears or never goes away.
    expect(ERROR_REPORTING_CONSENTS).toContain('unset');
    expect(ERROR_REPORTING_CONSENTS).toContain('denied');
  });
});

/**
 * The consent question is answerable from the product, not only by hand-crafting a PATCH.
 *
 * This is the assertion whose absence let the notice ship undismissable: the gate was built, the
 * banner was built, the endpoint accepted the field — and no screen offered it, so the one state
 * the notice's own docstring promises it can leave was unreachable. Every piece existed and the
 * feature did not work.
 *
 * A source scan rather than a render, for the same reason the no-ranking scan above is one: the
 * page is a Server Component that reaches for a database, and what needs pinning is that the
 * control is *wired in* — which is a fact about the file, not about a fixture.
 */
describe('the error-reporting consent can be answered on /privacy', () => {
  const source = readFileSync(join(WEB_ROOT, 'app', 'privacy', 'page.tsx'), 'utf8');

  it('renders the control', () => {
    expect(source, '/privacy does not render ErrorReportingControls').toContain('<ErrorReportingControls');
    expect(source).toContain("from '../../components/privacy-controls'");
  });

  it('hands it the stored answer rather than a literal', () => {
    // A hard-coded `consent="unset"` would render a control that always looked unanswered and
    // silently discarded what the owner had already chosen.
    expect(source).toContain('consent={view.retention.errorReportingConsent}');
  });

  it('gates it to owners, exactly as the retention windows are', () => {
    /**
     * `/api/privacy/settings` PATCH is owner-only, so a control a manager could press would 403 —
     * and a control that refuses when pressed reads as a broken product rather than as a
     * permission boundary. Asserted against the same `isOwner` the retention selects use, so the
     * two cannot drift into disagreeing about who may change the organization's posture.
     */
    const controlLine = /<ErrorReportingControls[^>]*>/.exec(source)?.[0] ?? '';

    expect(controlLine, 'the control is not owner-gated').toContain('canEdit={isOwner}');
    expect(source).toContain('<RetentionControls');
    expect(/<RetentionControls[\s\S]*?\/>/.exec(source)?.[0]).toContain('canEdit={isOwner}');
  });
});
