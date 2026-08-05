// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROLE_CAPABILITIES } from '@compass/auth';
import axe, { type Result } from 'axe-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AlignmentEvidence } from '../components/alignment-evidence';
import { ArchiveIndex } from '../components/archive-index';
import { CalibrationCollar } from '../components/calibration-collar';
import { CompletionLadder } from '../components/completion-ladder';
import { EmptyState } from '../components/empty-state';
import { FreshnessPanel } from '../components/freshness-panel';
import {
  AnonymizeControl,
  ChannelToggle,
  DeletionControls,
  MinimizationControls,
  RetentionControls,
} from '../components/privacy-controls';
import { ReportDiffDocument } from '../components/report-diff';
import { ReportDocument } from '../components/report-document';
import { SeatManager } from '../components/seat-manager';
import { SignInPanel } from '../components/sign-in-panel';
import { StatedFailure } from '../components/stated-failure';
import { buildReportDiffView } from '../lib/diff-source';
import { EMPTY_STATES } from '../lib/empty-states';
import { buildReportView } from '../lib/view-model';

import {
  diffPairFixture,
  emptyBundle,
  fallbackBundle,
  freshnessAbsent,
  freshnessComplete,
  freshnessWithMissingSource,
  narratedBundle,
  storedBundle,
} from './helpers/report-fixture';

/**
 * WCAG 2.1 AA, asserted rather than asserted-to-have-been-considered.
 *
 * ## What runs where, and why it is split in two
 *
 * **axe-core, in jsdom, over real rendered markup.** This is what catches structure: a control with
 * no accessible name, a `aria-labelledby` pointing at nothing, two landmarks with one name, a list
 * with a non-`li` child, a heading level skipped. Every surface below is rendered by the *same*
 * component the page renders, from the same fixtures the view tests use, so a violation here is a
 * violation a reader would meet.
 *
 * **Colour contrast, computed from the design tokens.** Deliberately *not* left to axe. axe's
 * `color-contrast` rule needs a layout engine and a cascade to know what colour a pixel ends up, and
 * jsdom has neither — so in jsdom that rule returns `incomplete` for every node and proves nothing.
 * A suite that ran axe and reported "no contrast violations" would be reporting that it did not
 * look. So the ratios are computed directly from `globals.css`, for both themes, in
 * `describe('contrast')` below. That is narrower than a browser audit and it is *sound*, which the
 * alternative is not.
 *
 * ## The severities that fail this file
 *
 * `critical` and `serious`, per the acceptance criterion. `moderate` and `minor` are reported in the
 * failure message when something else fails, so they are visible without being a gate — axe files
 * some real-but-arguable rules (`region`, `landmark-one-main`) at moderate, and a fragment rendered
 * without its page shell trips those for reasons that are about the test harness rather than the
 * product.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The rule set: WCAG 2.0/2.1 A and AA, which is exactly what the criterion names. */
const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
};

const BLOCKING_IMPACTS: readonly axe.ImpactValue[] = ['critical', 'serious'];

/**
 * Silences jsdom's "getContext() is not implemented" notice, ten times per run.
 *
 * axe's `color-contrast` rule reaches for a canvas to sample rendered pixels. jsdom has no canvas,
 * so every call logs a page of noise and the rule returns `incomplete` — which is the whole reason
 * contrast is computed from the tokens in `describe('AA contrast')` instead of being left to axe.
 * Stubbing it keeps the failure output readable; it removes no coverage, because the rule could not
 * have reached a verdict either way.
 */
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * Renders markup into the document and runs axe over it.
 *
 * `document.body.innerHTML` rather than a detached fragment: axe walks the tree from a real root and
 * several rules (landmark uniqueness, heading order, region) are only meaningful against a document.
 */
async function violationsOf(markup: string): Promise<readonly Result[]> {
  document.body.innerHTML = markup;
  const results = await axe.run(document.body, AXE_OPTIONS);
  return results.violations;
}

const describeViolation = (violation: Result): string =>
  `[${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help}\n` +
  violation.nodes.map((node) => `      ${node.html}`).join('\n');

/** Fails on critical and serious; prints everything axe found, so the rest is visible. */
async function expectNoBlockingViolations(label: string, markup: string): Promise<void> {
  const violations = await violationsOf(markup);
  const blocking = violations.filter((violation) => BLOCKING_IMPACTS.includes(violation.impact ?? 'minor'));

  expect(
    blocking.map(describeViolation),
    `${label} has critical or serious accessibility violations.\n` +
      `Everything axe reported:\n${violations.map(describeViolation).join('\n') || '      (nothing)'}`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// The surfaces the criterion names
// ---------------------------------------------------------------------------

const reportMarkup = (bundle = storedBundle(), freshness = freshnessComplete()): string =>
  renderToStaticMarkup(<ReportDocument view={buildReportView({ bundle, freshness })} />);

describe('axe reports no critical or serious violations', () => {
  it('on the report view', async () => {
    await expectNoBlockingViolations('the report view', reportMarkup());
  });

  it('on the report view in the narrated voice', async () => {
    // A different component tree: section prose owns the read and each claim renders as receipts,
    // so the accessible names come from somewhere else entirely.
    await expectNoBlockingViolations('the narrated report view', reportMarkup(narratedBundle()));
  });

  it('on a report with a missing source, where the honest degradation prose renders', async () => {
    await expectNoBlockingViolations(
      'the report with a missing source',
      reportMarkup(storedBundle(), freshnessWithMissingSource()),
    );
  });

  it('on a report whose narration fell back to the template renderer', async () => {
    // The disclosure note is a `role="status"` live region — worth its own pass, because a
    // mislabelled live region is exactly the kind of thing that only shows up under audit.
    await expectNoBlockingViolations('the fallback report view', reportMarkup(fallbackBundle()));
  });

  it('on a genuinely empty day, where every section states an absence', async () => {
    await expectNoBlockingViolations('the empty report view', reportMarkup(emptyBundle()));
  });

  it('on the freshness panel with no ingest record at all', async () => {
    const view = buildReportView({ bundle: storedBundle(), freshness: freshnessAbsent() });
    await expectNoBlockingViolations(
      'the freshness panel with no ingest record',
      renderToStaticMarkup(<FreshnessPanel freshness={view.freshness} />),
    );
  });

  it('on the evidence panel, opened', async () => {
    /**
     * Rendered with the disclosure *open*, which is the state that matters.
     *
     * A closed `<details>` hides its body from the accessibility tree, so auditing it shut would
     * audit the summary and skip every row, every `<dl>` and every mono token inside — the whole
     * thing this panel exists to show. `open` is forced on the rendered markup rather than on the
     * component, because whether it starts open is a product decision and this is a test about what
     * is inside it.
     */
    const view = buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() });
    const alignments = view.sections
      .flatMap((section) => section.items)
      .map((item) => item.alignment)
      .filter((alignment): alignment is NonNullable<typeof alignment> => alignment !== null);

    expect(alignments.length, 'the fixture carries no alignment verdict, so this asserts nothing').toBeGreaterThan(0);

    for (const alignment of alignments) {
      const markup = renderToStaticMarkup(<AlignmentEvidence alignment={alignment} />).replace(
        '<details ',
        '<details open ',
      );
      await expectNoBlockingViolations(`the evidence panel for ${alignment.panelId}`, markup);
    }
  });

  it('on the confidence collar', async () => {
    const view = buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() });
    await expectNoBlockingViolations(
      'the confidence collar',
      renderToStaticMarkup(<CalibrationCollar collar={view.collar} />),
    );
  });

  it('on the sign-in panel, which is the one form an unauthenticated reader meets', async () => {
    await expectNoBlockingViolations(
      'the sign-in panel',
      renderToStaticMarkup(<SignInPanel demoCredentials={{ email: 'owner@example.com', password: 'a-long-password' }} />),
    );
  });

  /**
   * The archive: the fourth surface the criterion names, and the one that had no assertion.
   *
   * Two shapes, because they fail differently. The **index** is nested lists with a heading per date
   * — list structure and heading order are exactly what axe catches and exactly what hand-written
   * nesting gets wrong. A **permalinked report** is the report view again, but reached by a route
   * that renders a *stored* row including its degradation flags, which is the state a reader is most
   * likely to be sent a link to.
   */
  it('on the archive index', async () => {
    const days = [
      {
        reportDate: '2026-07-30',
        entries: [
          {
            reportId: 'report-platform-0730',
            scopeLabel: 'platform',
            scopeKind: 'team',
            scopeKey: 'platform',
            reportDate: '2026-07-30',
            href: '/archive/report-platform-0730',
            itemCount: 7,
            coverageStatus: 'complete',
            fallbackRenderer: false,
            generatedAtLabel: '30 July 2026, 06:00',
          },
          // A degraded row, because the marks beside it are extra content and extra content is where
          // a contrast or name violation would appear.
          {
            reportId: 'report-payments-0730',
            scopeLabel: 'payments',
            scopeKind: 'team',
            scopeKey: 'payments',
            reportDate: '2026-07-30',
            href: '/archive/report-payments-0730',
            itemCount: 1,
            coverageStatus: 'partial',
            fallbackRenderer: true,
            generatedAtLabel: '30 July 2026, 06:00',
          },
        ],
      },
      {
        reportDate: '2026-07-29',
        entries: [
          {
            reportId: 'report-platform-0729',
            scopeLabel: 'platform',
            scopeKind: 'team',
            scopeKey: 'platform',
            reportDate: '2026-07-29',
            href: '/archive/report-platform-0729',
            itemCount: 4,
            coverageStatus: 'complete',
            fallbackRenderer: false,
            generatedAtLabel: '29 July 2026, 06:00',
          },
        ],
      },
    ];

    await expectNoBlockingViolations('the archive index', renderToStaticMarkup(<ArchiveIndex days={days} />));
  });

  /**
   * The side-by-side diff, in both states.
   *
   * Its structure is the part worth auditing: a list of rows, a two-column grid inside each, a
   * `<details>` disclosure per side and a `<dl>` of payload fields inside that. Nested lists, nested
   * disclosures and definition lists are exactly what axe checks and exactly what hand-written nesting
   * gets wrong — and the "nothing changed" state is a different tree with no rows at all.
   */
  it('on the side-by-side report diff', async () => {
    await expectNoBlockingViolations(
      'the report diff',
      renderToStaticMarkup(<ReportDiffDocument diff={buildReportDiffView(diffPairFixture())} />),
    );
  });

  it('on a diff where nothing changed', async () => {
    const bundle = storedBundle();
    await expectNoBlockingViolations(
      'the unchanged report diff',
      renderToStaticMarkup(
        <ReportDiffDocument diff={buildReportDiffView({ before: bundle, after: bundle })} />,
      ),
    );
  });

  it('on an archive with nothing in it yet', async () => {
    // The empty state is a first-class surface here, not a skeleton box, so it is audited too.
    await expectNoBlockingViolations('the empty archive index', renderToStaticMarkup(<ArchiveIndex days={[]} />));
  });

  it('on a permalinked archived report, rendered exactly as it was stored', async () => {
    await expectNoBlockingViolations('the permalinked archived report', reportMarkup(fallbackBundle()));
  });
});

/**
 * The configuration surfaces.
 *
 * These are the screens with the most *controls* — radios, checkboxes, text inputs, destructive
 * buttons — and therefore the most ways to lose a label. The report is mostly prose and links; a
 * fieldset of radio options is where a missing accessible name actually happens.
 *
 * Rendered from literal props rather than from a database, which is what makes them assertable at all:
 * each is a client component that takes its whole view as a value, so the test constructs the awkward
 * states on purpose — a seat you cannot manage, a control the reader lacks permission to change, an
 * empty roster.
 */
describe('axe reports no critical or serious violations on the configuration screens', () => {
  it('on the seat manager, as an owner who may change things', async () => {
    await expectNoBlockingViolations(
      'the seat manager',
      renderToStaticMarkup(
        <SeatManager
          seats={[
            {
              membershipId: 'm-1',
              email: 'priya@example.com',
              displayName: 'Priya Raman',
              role: 'owner',
              status: 'active',
              hasPassword: true,
              teamKeys: ['platform'],
              invitedAtLabel: '2026-07-01 09:00',
              isYou: true,
            },
            {
              membershipId: 'm-2',
              email: 'marcus@example.com',
              displayName: 'Marcus Hale',
              role: 'manager',
              status: 'pending',
              hasPassword: false,
              teamKeys: [],
              invitedAtLabel: '2026-07-30 11:20',
              isYou: false,
            },
          ]}
          canManage
          knownTeamKeys={['platform', 'checkout']}
          // The real table, so the sentence beside each seat is the one a reader gets.
          roleCapabilities={ROLE_CAPABILITIES}
        />,
      ),
    );
  });

  it('on the seat manager, as a manager who may only read it', async () => {
    // The read-only rendering is a different tree: controls become text, and text that used to be a
    // label has to still name what it describes.
    await expectNoBlockingViolations(
      'the read-only seat manager',
      renderToStaticMarkup(
        <SeatManager
          seats={[]}
          canManage={false}
          knownTeamKeys={['platform']}
          roleCapabilities={ROLE_CAPABILITIES}
        />,
      ),
    );
  });

  it('on the retention controls', async () => {
    await expectNoBlockingViolations(
      'the retention controls',
      renderToStaticMarkup(<RetentionControls rawEventRetentionDays={90} derivedRetentionYears={3} canEdit />),
    );
  });

  it('on the minimization controls, whose radio labels stack a title over a description', async () => {
    /**
     * Each mode is a radio with an `id`, a sibling `<label htmlFor>` carrying the title, and a second
     * sibling tied on with `aria-describedby` carrying the explanation.
     *
     * That split is the point of auditing it: the *name* is the mode ("Redacted") and the
     * *description* is the paragraph, so a screen reader announces the choice and then the reasoning
     * rather than one run-on string. A wrapping `<label>` containing both would have made the
     * accessible name the whole paragraph.
     */
    await expectNoBlockingViolations(
      'the minimization controls',
      renderToStaticMarkup(<MinimizationControls mode="redacted" canEdit />),
    );
  });

  it('on the retention and minimization controls a viewer cannot change', async () => {
    // `disabled` on a fieldset removes its controls from the tab order, which is correct, but it must
    // not remove the *explanation* of why they are unavailable.
    await expectNoBlockingViolations(
      'the read-only privacy controls',
      renderToStaticMarkup(
        <>
          <RetentionControls rawEventRetentionDays={30} derivedRetentionYears={null} canEdit={false} />
          <MinimizationControls mode="none" canEdit={false} />
        </>,
      ),
    );
  });

  /**
   * The rest of the privacy screen, including the destructive controls.
   *
   * These three were the gap: they are exported from the same file as the two above, they are the
   * controls that *delete an organization* and *withdraw a person's name*, and nothing audited them.
   * Each is rendered in every state its props can produce, because the awkward state is the one that
   * fails — a control that is present but refused, a channel Compass will not read, an export a
   * member may not download.
   */
  it('on the deletion controls, in all four permission combinations', async () => {
    for (const canDeleteOrganization of [true, false]) {
      for (const canExport of [true, false]) {
        await expectNoBlockingViolations(
          `the deletion controls (organization: ${canDeleteOrganization}, export: ${canExport})`,
          renderToStaticMarkup(
            <DeletionControls canDeleteOrganization={canDeleteOrganization} canExport={canExport} />,
          ),
        );
      }
    }
  });

  it('on the channel toggle, for a channel Compass will read and one it refuses', async () => {
    // The non-public kinds render an extra stated sentence and a disabled control, which is a
    // different tree — and the one where a disabled button with no explanation would slip through.
    for (const [conversationKind, enabled] of [
      ['public_channel', false],
      ['public_channel', true],
      ['private_channel', false],
      ['direct_message', false],
      ['group_message', false],
    ] as const) {
      await expectNoBlockingViolations(
        `the channel toggle (${conversationKind}, enabled: ${enabled})`,
        renderToStaticMarkup(
          <ChannelToggle
            conversationKey="C123CHECKOUT"
            conversationName="checkout-standup"
            conversationKind={conversationKind}
            enabled={enabled}
          />,
        ),
      );
    }
  });

  it('on the anonymize control, both before and after a name is withdrawn', async () => {
    for (const anonymized of [false, true]) {
      await expectNoBlockingViolations(
        `the anonymize control (anonymized: ${anonymized})`,
        renderToStaticMarkup(
          <AnonymizeControl developerKey="priya-raman" displayName="Priya Raman" anonymized={anonymized} />,
        ),
      );
    }
  });

  it('gives those three action buttons a name that flips without also claiming a pressed state', () => {
    /**
     * A toggle may change its name or its `aria-pressed`, never both.
     *
     * These carried both, which announced the state twice and in opposite senses: "stop reading this
     * channel, pressed" when the channel *is* being read reads as the exact opposite of the truth.
     * They are action buttons whose label names the act, so the label is what stays and
     * `aria-pressed` is what went.
     */
    const markup =
      renderToStaticMarkup(
        <ChannelToggle
          conversationKey="C1"
          conversationName="checkout-standup"
          conversationKind="public_channel"
          enabled
        />,
      ) + renderToStaticMarkup(<AnonymizeControl developerKey="p" displayName="Priya Raman" anonymized />);

    expect(markup).not.toContain('aria-pressed');
    // And the labels still say which act they perform, which is what carries the state instead.
    expect(markup).toContain('stop reading this channel');
    expect(markup).toContain('restore Priya Raman’s name');
  });

  it('on a designed empty state', async () => {
    for (const copy of Object.values(EMPTY_STATES)) {
      await expectNoBlockingViolations(
        `the empty state for ${copy.route}`,
        renderToStaticMarkup(<EmptyState copy={copy} />),
      );
    }
  });

  it('on a stated failure, which is what a reader meets when the substrate is down', async () => {
    await expectNoBlockingViolations(
      'a stated failure',
      renderToStaticMarkup(
        <StatedFailure detail="Compass could not reach its own records, so nothing is shown rather than a guess." />,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Heading hierarchy and landmarks
// ---------------------------------------------------------------------------

describe('the six sections use a correct heading hierarchy', () => {
  const headingsIn = (markup: string): readonly { readonly level: number; readonly text: string }[] => {
    document.body.innerHTML = markup;
    return [...document.body.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }));
  };

  it('opens with exactly one h1 and never skips a level', () => {
    const headings = headingsIn(reportMarkup());

    expect(headings.filter((heading) => heading.level === 1)).toHaveLength(1);
    expect(headings[0]?.level, 'the document must open at level 1').toBe(1);

    // The rule WCAG 1.3.1 is actually about: no jump of more than one level on the way down.
    let previous = headings[0]?.level ?? 1;
    for (const heading of headings) {
      expect(
        heading.level - previous,
        `"${heading.text}" jumps from h${previous} to h${heading.level}`,
      ).toBeLessThanOrEqual(1);
      previous = heading.level;
    }
  });

  it('gives each of the six sections its own h2, in the fixed order', () => {
    const headings = headingsIn(reportMarkup());
    const sectionTitles = buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() }).sections.map(
      (section) => section.title,
    );

    const levelTwo = headings.filter((heading) => heading.level === 2).map((heading) => heading.text);

    for (const title of sectionTitles) {
      expect(
        levelTwo.some((text) => text.includes(title)),
        `section "${title}" has no h2 of its own`,
      ).toBe(true);
    }

    // In the Six Spine's order, and no section is promoted or demoted relative to its siblings.
    const positions = sectionTitles.map((title) => levelTwo.findIndex((text) => text.includes(title)));
    expect(positions, 'the six h2s must appear in the spine order').toEqual([...positions].sort((a, b) => a - b));
  });

  it('labels every section by its own heading, so a rotor names them', () => {
    document.body.innerHTML = reportMarkup();

    for (const section of document.body.querySelectorAll('section[aria-labelledby]')) {
      const id = section.getAttribute('aria-labelledby') ?? '';
      const label = document.getElementById(id);
      expect(label, `aria-labelledby="${id}" points at no element`).not.toBeNull();
      expect((label?.textContent ?? '').trim().length, `${id} is an empty label`).toBeGreaterThan(0);
    }
  });
});

describe('landmarks', () => {
  it('has exactly one main and exactly one navigation, each named once', () => {
    document.body.innerHTML = reportMarkup();

    expect(document.body.querySelectorAll('main')).toHaveLength(1);

    /**
     * One navigation landmark, not two.
     *
     * The Six Spine renders a phone strip and a desktop rail, and both are in the DOM at once with
     * only CSS deciding which is displayed. As two sibling `<nav aria-label="Report sections">`
     * elements that was a duplicate landmark: identical role, identical accessible name, and a rotor
     * offering the reader a choice between two entries that are the same thing. They are now one
     * `<nav>` with two presentations inside it.
     */
    const navs = [...document.body.querySelectorAll('nav')];
    expect(navs, 'two navigation landmarks with one name are indistinguishable in a rotor').toHaveLength(1);
    expect(navs[0]?.getAttribute('aria-label')).toBe('Report sections');
  });

  it('puts the report inside main, with the spine outside it', () => {
    document.body.innerHTML = reportMarkup();

    const main = document.body.querySelector('main');
    expect(main?.getAttribute('id')).toBe('report');
    // The skip link in the root layout targets `#report`; if the id moved, the link would go nowhere.
    expect(main?.querySelector('nav'), 'the section rail is navigation, not content').toBeNull();
    expect(main?.querySelector('h1')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The evidence panel: announced, operable, dismissible
// ---------------------------------------------------------------------------

describe('the evidence panel is announced and dismissible', () => {
  const panelMarkup = (): string => {
    const view = buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() });
    const alignment = view.sections
      .flatMap((section) => section.items)
      .map((item) => item.alignment)
      .find((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    if (alignment === undefined) throw new Error('the fixture carries no alignment verdict');
    return renderToStaticMarkup(<AlignmentEvidence alignment={alignment} />);
  };

  /**
   * A native `<details>`, and deliberately not a dialog.
   *
   * A `role="dialog"` panel would need JavaScript to open, to trap focus, to restore it and to close
   * on Escape — and `tests/cold-start.test.tsx` asserts this component ships no client bundle,
   * because the evidence behind a claim has to open on a phone with a dead battery saver and in the
   * static HTML the smoke test fetches. A disclosure gets all four behaviours from the browser: the
   * summary is focusable and in the tab order, Enter and Space toggle it, it is announced as a
   * collapsed/expanded group, and the same key that opened it closes it.
   *
   * The trade is real and worth stating: a disclosure does not trap focus, so a screen-reader user
   * continues into the panel body in reading order rather than being held inside it. For evidence
   * *inline beneath the claim it belongs to*, continuing in reading order is the better behaviour —
   * the panel is part of the document, not an interruption of it.
   */
  it('is a native disclosure, so it opens with no JavaScript', () => {
    document.body.innerHTML = panelMarkup();

    const details = document.body.querySelector('details');
    const summary = details?.querySelector('summary');

    expect(details, 'the evidence panel must be a disclosure element').not.toBeNull();
    expect(summary, 'a details with no summary is not operable').not.toBeNull();
    // The component is a Server Component: no directive, no handler attributes in the markup.
    expect(document.body.innerHTML).not.toContain('onclick');
  });

  it('is reachable and toggled by the keyboard, with the browser managing the state', () => {
    document.body.innerHTML = panelMarkup();

    const details = document.body.querySelector('details') as HTMLDetailsElement;
    const summary = details.querySelector('summary') as HTMLElement;

    // `<summary>` is focusable without a tabindex — that is what makes it operable for free, and a
    // `tabindex="-1"` on it would silently remove the panel from the tab order.
    expect(summary.getAttribute('tabindex')).toBeNull();

    expect(details.open, 'the panel starts closed so it does not interrupt the read').toBe(false);
    details.open = true;
    expect(details.open).toBe(true);
    details.open = false;
    expect(details.open, 'the same affordance that opened it closes it').toBe(false);
  });

  it('carries an accessible name that says what opening it will show', () => {
    document.body.innerHTML = panelMarkup();

    const summary = document.body.querySelector('summary');
    const name = (summary?.textContent ?? '').replace(/\s+/g, ' ').trim();

    // Not "more", not "details", not a bare caret: the name states the act.
    expect(name).toMatch(/How Compass resolved this|What Compass compared/);
    expect(name.length).toBeGreaterThan(20);
  });

  it('names a body element that actually exists, so `aria-controls` is not a dangling pointer', () => {
    document.body.innerHTML = panelMarkup();

    const summary = document.body.querySelector('summary');
    const controls = summary?.getAttribute('aria-controls');

    expect(controls, 'the summary must say which region it controls').not.toBeNull();
    expect(document.getElementById(controls ?? ''), `aria-controls="${controls}" points at nothing`).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Keyboard operability and visible focus
// ---------------------------------------------------------------------------

describe('every interactive element is reachable and operable by keyboard', () => {
  /** Elements that take focus without help, plus anything given an explicit positive tabindex. */
  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';

  it('gives every interactive element on the report a keyboard path', () => {
    document.body.innerHTML = reportMarkup();

    const interactive = [...document.body.querySelectorAll(FOCUSABLE)];
    expect(interactive.length, 'the report has no interactive elements, so this asserts nothing').toBeGreaterThan(5);

    const unreachable = interactive
      .filter((element) => {
        const tabindex = element.getAttribute('tabindex');
        // `-1` removes an element from the tab order. On a genuinely interactive element that is a
        // keyboard trap in the other direction: reachable by mouse, unreachable by Tab.
        return tabindex !== null && Number(tabindex) < 0;
      })
      .map((element) => element.outerHTML);

    expect(unreachable, 'these are operable by mouse and unreachable by keyboard').toEqual([]);
  });

  it('puts no positive tabindex anywhere, so the tab order is the reading order', () => {
    document.body.innerHTML = reportMarkup();

    const jumped = [...document.body.querySelectorAll('[tabindex]')]
      .filter((element) => Number(element.getAttribute('tabindex')) > 0)
      .map((element) => element.outerHTML);

    // A positive tabindex reorders the whole document's tab sequence, not just this element's.
    expect(jumped, 'a positive tabindex takes an element out of reading order').toEqual([]);
  });

  it('gives every link an accessible name', () => {
    document.body.innerHTML = reportMarkup();

    const unnamed = [...document.body.querySelectorAll('a[href]')]
      .filter((anchor) => {
        const text = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
        return (
          text.length === 0 &&
          (anchor.getAttribute('aria-label') ?? '').length === 0 &&
          (anchor.getAttribute('title') ?? '').length === 0
        );
      })
      .map((anchor) => anchor.outerHTML);

    expect(unnamed, 'a link with no name is announced as its own URL').toEqual([]);
  });

  it('never hides a focusable element from assistive technology', () => {
    // `aria-hidden` on something focusable is the specific combination that produces a control a
    // sighted keyboard user can reach and a screen-reader user cannot hear.
    document.body.innerHTML = reportMarkup();

    const hiddenButFocusable = [...document.body.querySelectorAll('[aria-hidden="true"]')]
      .flatMap((element) => [
        ...(element.matches(FOCUSABLE) ? [element] : []),
        ...element.querySelectorAll(FOCUSABLE),
      ])
      .map((element) => element.outerHTML);

    expect(hiddenButFocusable, 'these are focusable but hidden from assistive technology').toEqual([]);
  });

  it('declares a visible focus indicator for every control, in one place', () => {
    /**
     * The indicator itself is CSS, so it is asserted against the stylesheet rather than the DOM —
     * jsdom applies no cascade and would report every computed outline as empty.
     *
     * The global `:focus-visible` rule is what makes this a property of the page rather than of each
     * component: a control added tomorrow inherits it without anybody remembering to.
     */
    const css = readFileSync(join(WEB_ROOT, 'app', 'globals.css'), 'utf8');

    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
    expect(css).toMatch(/--focus-ring:/);

    /**
     * And nothing may take it away without putting one back.
     *
     * Every `outline: none` in the sheet is paired with a selector that restores a visible indicator.
     * `.goal-input` is the one that needed fixing: it set `outline: none` on `:focus` and left a
     * keyboard reader with a one-pixel border change as their only signal.
     */
    const suppressors = [...css.matchAll(/([^{}]+)\{[^}]*outline:\s*none/g)]
      // The capture runs back to the previous brace, so it picks up any comment block sitting above
      // the rule. Only the last line of it is the selector.
      .map((match) => match[1]!.trim().split('\n').pop()!.trim())
      .filter((selector) => selector.length > 0);

    expect(suppressors.length, 'no rule suppresses an outline, so this asserts nothing').toBeGreaterThan(0);

    /**
     * The body of one rule, found by its selector.
     *
     * Matching the block and *then* testing its body — rather than doing both in one
     * concatenated regex — is what makes the two shapes distinguishable. `.goal-input` sets
     * `outline: none` on `:focus` and restores it in a **separate** `:focus-visible` rule, while
     * `.feedback-reason` and `.app-feedback__field` suppress and restore **inside the same
     * `:focus-visible` block**. One regex spanning `{[^}]*outline:` cannot express both, and the
     * previous attempt to make it do so was worse than wrong: `outline:\s*[^n]` let `\s*` match
     * empty so `[^n]` matched the *space* after the colon, which `outline: none` satisfies. Every
     * selector passed and nothing was checked.
     */
    const bodyOf = (selector: string): string | null => {
      const at = css.indexOf(`${selector} {`);
      if (at === -1) return null;
      const open = css.indexOf('{', at);
      const close = css.indexOf('}', open);
      return open === -1 || close === -1 ? null : css.slice(open + 1, close);
    };

    /**
     * One declaration's value, or null when the property is not declared.
     *
     * Read the value out and *then* judge it. Trying to express "declared and not `none`" as a
     * single regex is what produced both of this test's previous bugs: `outline:\s*[^n]` matched
     * the space after the colon, and a `(?!none\b)` lookahead placed after `\s*` is defeated by
     * the engine backtracking `\s*` to empty so the negative lookahead sees ` none` instead of
     * `none`. A parse cannot be fooled that way.
     *
     * `outline\s*:` does not also match `outline-offset:` — the colon has to follow the property
     * name with only whitespace between.
     */
    const valueOf = (body: string, property: string): string | null => {
      const found = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(body);
      return found === null ? null : found[1]!.trim();
    };

    /**
     * A visible keyboard indicator, in any of the three forms WCAG 2.4.7 accepts.
     *
     * It does not require `outline` specifically — a 2px box-shadow ring and a colour change on
     * the border are both perceivable focus indicators, and both are what this sheet actually
     * uses for the two teal-ringed text fields. What it does require is that *something* visible
     * is declared, so a rule that removes the outline and offers nothing still fails.
     */
    const isVisible = (value: string | null): boolean =>
      value !== null && value.length > 0 && value !== 'none';

    const declaresIndicator = (body: string): boolean =>
      isVisible(valueOf(body, 'outline')) ||
      isVisible(valueOf(body, 'box-shadow')) ||
      isVisible(valueOf(body, 'border-color'));

    for (const selector of suppressors) {
      const base = selector.replace(/:focus(-visible)?$/, '').trim();

      // Either the suppressing block restores an indicator itself, or a sibling
      // `:focus-visible` rule does. Both are legitimate; neither being true is not.
      const ownBody = bodyOf(selector) ?? '';
      const keyboardBody = bodyOf(`${base}:focus-visible`) ?? '';

      expect(
        declaresIndicator(ownBody) || declaresIndicator(keyboardBody),
        `${selector} removes the outline and nothing restores a visible indicator for keyboard focus`,
      ).toBe(true);
    }

    /**
     * And the predicate is not vacuous, proved on a fixture rather than asserted.
     *
     * This is the guard the old version needed and did not have: a rule that suppresses the
     * outline and offers nothing back must be *rejected*. Without this, any future weakening of
     * `declaresIndicator` goes unnoticed exactly as the `[^n]` bug did.
     */
    expect(declaresIndicator('\n  outline: none;\n  color: red;\n')).toBe(false);
    expect(declaresIndicator('\n  outline: none;\n  box-shadow: 0 0 0 2px teal;\n')).toBe(true);
    expect(declaresIndicator('\n  outline: 2px solid var(--focus-ring);\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Contrast, computed from the tokens rather than guessed at
// ---------------------------------------------------------------------------

describe('AA contrast across light and dark', () => {
  const css = readFileSync(join(WEB_ROOT, 'app', 'globals.css'), 'utf8');

  /** Every `--name: #rrggbb` inside the block a selector opens, so themes are read apart. */
  function tokensIn(blockSelector: RegExp): Readonly<Record<string, string>> {
    const opening = blockSelector.exec(css);
    if (opening === null) throw new Error(`no block matched ${String(blockSelector)}`);

    const from = opening.index + opening[0].length;
    // The token block ends at the first closing brace at the same nesting depth.
    let depth = 1;
    let end = from;
    while (end < css.length && depth > 0) {
      if (css[end] === '{') depth += 1;
      if (css[end] === '}') depth -= 1;
      end += 1;
    }

    const tokens: Record<string, string> = {};
    for (const match of css.slice(from, end).matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
      tokens[match[1]!] = match[2]!;
    }
    return tokens;
  }

  const channel = (value: number): number =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

  function luminance(hex: string): number {
    const raw = hex.replace('#', '');
    const full = raw.length === 3 ? [...raw].map((digit) => digit + digit).join('') : raw.slice(0, 6);
    const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  /** WCAG 2.1 relative-contrast ratio: (lighter + 0.05) / (darker + 0.05). */
  function ratio(foreground: string, background: string): number {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  it('computes a ratio it can be trusted on', () => {
    // The two ends of the scale, to prove the arithmetic rather than assume it.
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(ratio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // A known WCAG boundary: zinc-500 on white is the value the stylesheet documents.
    expect(ratio('#71717a', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * Every block that declares a theme — all four of them.
   *
   * `:root` is light and `prefers-color-scheme: dark` is dark, and a reader whose system is set that
   * way is the *majority* case for a report opened at 08:45, so a token that only clears AA in light
   * fails for most of the people reading it.
   *
   * The two `data-theme` blocks are the explicit override the theme toggle stamps on the root
   * element, and they were the gap: they declare the same tokens again, and only the first two blocks
   * were parsed. An edit to `:root[data-theme='dark']` alone therefore passed a green suite while
   * changing what a reader who has chosen dark actually sees. Four blocks, four sets of assertions —
   * the duplication in the stylesheet is real, so the coverage has to match it rather than assume the
   * pairs agree.
   */
  const THEMES = [
    ['light (:root)', tokensIn(/:root\s*\{/)],
    ['dark (prefers-color-scheme)', tokensIn(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{/)],
    ['light (data-theme)', tokensIn(/:root\[data-theme='light'\]\s*\{/)],
    ['dark (data-theme)', tokensIn(/:root\[data-theme='dark'\]\s*\{/)],
  ] as const;

  it('found all four theme blocks, so none of the assertions below is over an empty object', () => {
    // Without this, a renamed selector would silently reduce every `it.each` below to a no-op on an
    // empty token map — which is exactly the shape of failure this whole suite exists to prevent.
    for (const [name, tokens] of THEMES) {
      expect(Object.keys(tokens).length, `${name} parsed no tokens`).toBeGreaterThan(5);
      expect(tokens['--surface'], `${name} declares no --surface`).toBeDefined();
    }
  });

  /** Text tokens that must clear 4.5:1 — body text, at every weight the page uses it. */
  const TEXT_TOKENS = ['--ink-strong', '--ink', '--ink-muted', '--ink-faint'] as const;

  it.each(THEMES)('%s: every text token clears 4.5:1 on the page background', (_theme, tokens) => {
    const background = tokens['--surface'];
    expect(background, 'the theme declares no --surface to measure against').toBeDefined();

    for (const token of TEXT_TOKENS) {
      const colour = tokens[token];
      expect(colour, `${token} is not declared in this theme`).toBeDefined();

      const measured = ratio(colour!, background!);
      expect(
        measured,
        `${token} (${colour}) on ${background} is ${measured.toFixed(2)}:1, below the 4.5:1 AA floor for body text`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  /**
   * SC 1.4.11, which axe cannot check and which therefore has to be arithmetic.
   *
   * The zero-violations gate above sees nothing here: axe-core implements no rule for non-text
   * contrast, so the boundary of a `<select>` could sit at 1.48:1 through a green suite — which is
   * exactly what happened. `--rule-strong` (zinc-300) was doing two jobs, and it could only do one of
   * them: a decorative hairline identifies nothing and is out of scope, while the border of the
   * retention selects on `/privacy`, the time-travel stepper and the feedback field *is* the only
   * thing telling a reader where the control is.
   *
   * So the two are separate tokens now, and this is the assertion that keeps them separate. 3:1 rather
   * than 4.5:1 because that is what the success criterion asks of a component boundary, and it is
   * checked in all four theme blocks for the same reason the text tokens are.
   */
  it.each(THEMES)('%s: the control boundary clears 3:1, which SC 1.4.11 requires', (_theme, tokens) => {
    const background = tokens['--surface'];
    const border = tokens['--control-border'];

    expect(border, '--control-border is not declared in this theme').toBeDefined();

    const measured = ratio(border!, background!);
    expect(
      measured,
      `--control-border (${border}) on ${background} is ${measured.toFixed(2)}:1, below the 3:1 floor ` +
        'SC 1.4.11 sets for the visual information identifying a UI component',
    ).toBeGreaterThanOrEqual(3);
  });

  it.each(THEMES)('%s: the decorative hairline is still allowed to be faint', (_theme, tokens) => {
    // The other half of the split, stated so nobody "fixes" it later. `--rule-strong` is a separator
    // and uncrossed ladder notches: it identifies no component, so 1.4.11 does not reach it, and
    // darkening it would put a heavy rule through a page whose whole argument is quiet typography.
    expect(tokens['--rule-strong'], '--rule-strong is not declared in this theme').toBeDefined();
  });

  it.each(THEMES)('%s: the raised surface is no worse than the page surface', (_theme, tokens) => {
    // Panels and the sign-in block sit on `--surface-raised`. Text that passes on one and fails on
    // the other is the failure nobody notices, because the audit was run on the page background.
    const raised = tokens['--surface-raised'] ?? tokens['--surface'];

    for (const token of TEXT_TOKENS) {
      const measured = ratio(tokens[token]!, raised!);
      expect(measured, `${token} on ${raised} is ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)('%s: the emerald used for text clears 4.5:1', (_theme, tokens) => {
    /**
     * `--verified-text` exists precisely because `--verified` does not clear AA as text on white.
     *
     * Emerald-600 is the brand's primary and it is used for *rules, notches and borders*, where the
     * 3:1 non-text floor applies. The moment it carries a word it has to clear 4.5:1, which is why
     * there is a second token set to emerald-700 in light. This asserts the distinction is real,
     * rather than a naming convention nobody enforces.
     */
    const measured = ratio(tokens['--verified-text']!, tokens['--surface']!);
    expect(
      measured,
      `--verified-text (${tokens['--verified-text']}) is ${measured.toFixed(2)}:1 on ${tokens['--surface']}`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s: the focus ring and the emerald mark clear the 3:1 non-text floor', (_theme, tokens) => {
    /**
     * WCAG 1.4.11, applied to the two graphics that actually carry state.
     *
     * `--verified` is the focus ring (`--focus-ring` is an alias for it) and the active tick on the
     * Six Spine. A focus indicator nobody can see is not an indicator, and the spine's tick is the
     * only thing saying which section you are in — both are UI components in 1.4.11's sense and both
     * are floored at 3:1.
     *
     * `--rule-strong` is deliberately **not** asserted here, and that is a judgement worth writing
     * down rather than an omission. It measures 1.48:1 in light and 1.91:1 in dark, and it is right
     * that it does: it draws hairline dividers and the *uncrossed* completion notches, and 1.4.11
     * exempts graphics whose information is available in text. `CompletionLadder` puts
     * `aria-hidden="true"` on the five marks and states the rung beside them — `R2 merged`, `no rung
     * crossed`, `no deploy signal available` — so the hairline encodes nothing a reader could lose by
     * not seeing it. `describe('the ladder states its rung in text')` below is what holds that claim
     * up; if the marks ever stopped being decorative, that test fails and this exemption stops
     * applying.
     */
    expect(tokens['--focus-ring'] ?? 'var(--verified)').toBeDefined();

    for (const token of ['--verified'] as const) {
      const measured = ratio(tokens[token]!, tokens['--surface']!);
      expect(
        measured,
        `${token} (${tokens[token]}) is ${measured.toFixed(2)}:1 on ${tokens['--surface']} — the focus ring must be visible`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('aliases the focus ring to the emerald that was just measured', () => {
    // Otherwise the assertion above measures a token the focus ring does not use.
    expect(css).toMatch(/--focus-ring:\s*var\(--verified\)/);
  });
});

describe('the ladder states its rung in text, which is what exempts the hairline notches', () => {
  it('hides the five marks from assistive technology and prints the rung beside them', () => {
    const view = buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() });
    const ladders = view.sections
      .flatMap((section) => section.items)
      .map((item) => item.ladder)
      .filter((ladder): ladder is NonNullable<typeof ladder> => ladder !== null);

    expect(ladders.length, 'the fixture carries no completion ladder, so this asserts nothing').toBeGreaterThan(0);

    for (const ladder of ladders) {
      document.body.innerHTML = renderToStaticMarkup(<CompletionLadder ladder={ladder} />);

      // The marks are decoration: hidden, and carrying no text of their own.
      const marks = document.body.querySelector('[aria-hidden="true"]');
      expect(marks, 'the five marks must be hidden from assistive technology').not.toBeNull();
      expect((marks?.textContent ?? '').trim(), 'the marks must carry no text a reader would miss').toBe('');

      // And the state is in the text that remains once the marks are removed.
      marks?.remove();
      const spoken = (document.body.textContent ?? '').replace(/\s+/g, ' ').trim();
      expect(spoken.length, 'the ladder says nothing without its marks').toBeGreaterThan(0);
      expect(
        spoken,
        'the rung a reader hears must name a rung or state that none was crossed',
      ).toMatch(/R[1-5]|no rung crossed/);
    }
  });
});
