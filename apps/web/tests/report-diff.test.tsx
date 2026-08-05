// @vitest-environment jsdom
import type { StoredReportBundle, StoredReportItem } from '@compass/db';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { ArchiveIndex } from '../components/archive-index';
import { ReportDiffDocument } from '../components/report-diff';
import { buildReportDiffView } from '../lib/diff-source';

import { diffPairFixture, storedBundle } from './helpers/report-fixture';

/**
 * The side-by-side diff view, and the fabrication check inside it.
 *
 * The engine's own behaviour — what counts as added, removed or changed — is asserted in
 * `packages/analysis/tests/report-diff.test.ts` against the real seeded corpus. This file asserts the
 * half that only exists once the components run: that both days are on the page, that a reviewer can
 * get from a claim to the payload behind it and from there to the artifact, and that a diff with
 * nothing in it *says so* rather than rendering two identical columns.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const YESTERDAY = '2026-07-30';
const TODAY = '2026-07-31';

/** The earlier report: same fixture, dated a day back. */
function earlier(): StoredReportBundle {
  const bundle = storedBundle();
  return {
    ...bundle,
    report: { ...bundle.report, id: 'report-0', reportDate: YESTERDAY },
    sections: bundle.sections,
  };
}

/** Maps the first section's items, which is where every case below is arranged. */
function withFirstSectionItems(
  bundle: StoredReportBundle,
  map: (items: readonly StoredReportItem[]) => readonly StoredReportItem[],
): StoredReportBundle {
  return {
    ...bundle,
    sections: bundle.sections.map((section, index) =>
      index === 0 ? { ...section, items: map(section.items) } : section,
    ),
  };
}

/**
 * A pair containing one changed item, one that left and one that appeared.
 *
 * From the shared fixture helper rather than built here, so the tree this file asserts on is the same
 * tree `accessibility.test.tsx` runs axe over. Two fixtures that drifted would mean the audited markup
 * and the asserted markup were different markup.
 */
const mixedPair = (): { before: StoredReportBundle; after: StoredReportBundle } => diffPairFixture();

const render = (before: StoredReportBundle, after: StoredReportBundle): string =>
  renderToStaticMarkup(<ReportDiffDocument diff={buildReportDiffView({ before, after })} />);

const textOf = (markup: string): string => {
  document.body.innerHTML = markup;
  return (document.body.textContent ?? '').replace(/\s+/g, ' ');
};

describe('both days are on the page, with markers', () => {
  it('shows each report’s date on every row', () => {
    const { before, after } = mixedPair();
    const text = textOf(render(before, after));

    expect(text).toContain(YESTERDAY);
    expect(text).toContain(TODAY);
  });

  it('marks added, removed and changed rows', () => {
    const { before, after } = mixedPair();
    document.body.innerHTML = render(before, after);

    const statuses = [...document.body.querySelectorAll('[data-diff-row]')].map((node) =>
      node.getAttribute('data-diff-row'),
    );

    expect(statuses).toContain('added');
    expect(statuses).toContain('removed');
    expect(statuses).toContain('changed');
  });

  it('states the marker in words, not only as a glyph', () => {
    // A bare `+`/`−` is unreadable to a screen reader and ambiguous to everyone else.
    const { before, after } = mixedPair();
    const text = textOf(render(before, after));

    expect(text).toContain('appeared');
    expect(text).toContain('left the report');
    expect(text).toContain('changed');
  });

  it('never colour-codes the change, per the design brief', () => {
    /**
     * Compass rations colour to emerald (verified positive fact) and teal (the manager's hand), and it
     * never colour-codes bad news. An item leaving the report is usually *good* — a blocker cleared —
     * so the conventional red/green diff palette would be backwards half the time while looking
     * authoritative. Status is carried by glyph, weight and rule thickness instead.
     */
    const { before, after } = mixedPair();
    const markup = render(before, after);

    expect(markup).not.toMatch(/text-red|bg-red|text-green|bg-green|text-emerald-|bg-emerald-/);
  });

  it('names the fields that moved on a changed row, with both values', () => {
    const { before, after } = mixedPair();
    const text = textOf(render(before, after));

    // "severity went from 30 to 45" is the fact. Making a reader diff two paragraphs by eye to find it
    // is how a real change gets missed among four unchanged sentences.
    expect(text).toContain('severityScore');
    expect(text).toContain('ageDays');
  });

  it('states an absence rather than leaving an empty column', () => {
    const { before, after } = mixedPair();
    document.body.innerHTML = render(before, after);

    const absences = [...document.body.querySelectorAll('[data-diff-absent="true"]')];
    expect(absences.length, 'an added and a removed row each have one empty side').toBeGreaterThan(0);
    for (const node of absences) {
      expect((node.textContent ?? '').trim().length, 'an empty cell reads as a rendering fault').toBeGreaterThan(
        10,
      );
    }
  });
});

describe('readable at 375px', () => {
  it('stacks the two columns on a phone and sits them side by side from md', () => {
    /**
     * A true two-column diff at 375px gives each column about 170px — four words a line. So the
     * earlier report sits *above* the later one on a phone, each labelled with its date, and they
     * become columns at `md`. The reading order is identical in both layouts.
     */
    const { before, after } = mixedPair();
    const markup = render(before, after);

    expect(markup).toContain('grid-cols-1');
    expect(markup).toContain('md:grid-cols-2');
  });

  it('sets no fixed pixel width that could overflow a narrow viewport', () => {
    const { before, after } = mixedPair();
    const markup = render(before, after);

    // A `w-[420px]` or a `min-w-[600px]` anywhere in this tree would put a horizontal scrollbar on the
    // page at 375px, which is the width the criterion names.
    expect(markup).not.toMatch(/\bw-\[\d{3,}px\]|\bmin-w-\[\d{3,}px\]/);
  });

  it('lets long payload values wrap rather than forcing a scroll', () => {
    const { before, after } = mixedPair();
    expect(render(before, after)).toContain('break-words');
  });
});

describe('the jump-to-next-change control', () => {
  it('links to the first change', () => {
    const { before, after } = mixedPair();
    const view = buildReportDiffView({ before, after });
    document.body.innerHTML = render(before, after);

    const nav = document.body.querySelector('nav[aria-label="Changes"]');
    expect(nav, 'there is no jump control').not.toBeNull();

    const link = nav?.querySelector('a');
    expect(link?.getAttribute('href')).toBe(`#${view.changeAnchors[0]}`);
  });

  it('points every change at the next one, and the last at nothing', () => {
    const { before, after } = mixedPair();
    const view = buildReportDiffView({ before, after });
    document.body.innerHTML = render(before, after);

    // A chain of anchors rather than a scroll handler: no client bundle, keyboard-operable for free.
    const nextLinks = [...document.body.querySelectorAll('a')]
      .filter((anchor) => (anchor.textContent ?? '').includes('Next change'))
      .map((anchor) => anchor.getAttribute('href'));

    expect(nextLinks).toEqual(view.changeAnchors.slice(1).map((anchor) => `#${anchor}`));
  });

  it('lands on a row that actually exists on the page', () => {
    const { before, after } = mixedPair();
    const view = buildReportDiffView({ before, after });
    document.body.innerHTML = render(before, after);

    expect(view.changeAnchors.length).toBeGreaterThan(0);
    for (const anchor of view.changeAnchors) {
      // A "next change" that pointed at nothing would be worse than no control at all.
      expect(document.getElementById(anchor), `#${anchor} points at no element`).not.toBeNull();
    }
  });

  it('offers no jump control when there is nothing to jump to', () => {
    const bundle = storedBundle();
    document.body.innerHTML = render(bundle, bundle);

    expect(document.body.querySelector('nav[aria-label="Changes"]')).toBeNull();
  });

  it('ships no client-side handler for it', () => {
    const { before, after } = mixedPair();
    const markup = render(before, after);

    // The fabrication check has to work on a phone with battery saver on, and be present in the static
    // HTML the smoke test fetches.
    expect(markup).not.toContain('onclick');
    expect(markup).not.toContain('onscroll');
  });
});

describe('nothing changed is stated, not implied', () => {
  it('says “nothing material changed” rather than rendering two identical columns', () => {
    const bundle = storedBundle();
    const text = textOf(render(bundle, bundle));

    expect(text).toContain('Nothing material changed');
  });

  it('explains what that means and how many items it checked', () => {
    const bundle = storedBundle();
    const view = buildReportDiffView({ before: bundle, after: bundle });
    const text = textOf(render(bundle, bundle));

    expect(view.hasChanges).toBe(false);
    expect(view.unchangedCount).toBeGreaterThan(0);
    // The reader is told the columns are not being hidden from them, and on what basis.
    expect(text).toContain('same stable id');
    expect(text).toContain(`${view.unchangedCount} items identical in both reports`);
  });

  it('renders no per-item rows in that state, so there is nothing to compare by eye', () => {
    const bundle = storedBundle();
    document.body.innerHTML = render(bundle, bundle);

    expect(document.body.querySelectorAll('[data-diff-row]')).toHaveLength(0);
  });
});

describe('the fabrication check', () => {
  it('shows the structured payload fields beside the rendered prose', () => {
    const { before, after } = mixedPair();
    document.body.innerHTML = render(before, after);

    const panels = [...document.body.querySelectorAll('details')];
    expect(panels.length, 'no claim can be expanded').toBeGreaterThan(0);

    const first = panels[0]!;
    // The prose is in the row; the payload is in the disclosure beneath it. Both on the page at once,
    // which is what "alongside" in the criterion means.
    expect(first.querySelector('dl'), 'the payload panel lists no fields').not.toBeNull();
    expect((first.textContent ?? '')).toContain('stableId');
  });

  it('is a native disclosure, so it opens with no JavaScript', () => {
    const { before, after } = mixedPair();
    document.body.innerHTML = render(before, after);

    const details = document.body.querySelector('details');
    const summary = details?.querySelector('summary');

    expect(summary, 'a details with no summary is not operable').not.toBeNull();
    // `<summary>` is focusable without a tabindex; a `-1` on it would remove the panel from the tab
    // order and make the fabrication check unreachable by keyboard.
    expect(summary?.getAttribute('tabindex')).toBeNull();
    expect(details?.hasAttribute('open'), 'it starts closed so the columns stay readable').toBe(false);
  });

  it('names what opening it will show, and points at a region that exists', () => {
    const { before, after } = mixedPair();
    document.body.innerHTML = render(before, after);

    const summary = document.body.querySelector('summary');
    const name = (summary?.textContent ?? '').replace(/\s+/g, ' ').trim();

    // Not "more", not a bare caret: the name states the act and the count.
    expect(name).toContain('What Compass computed this from');
    expect(name).toMatch(/\d+ payload field/);

    const controls = summary?.getAttribute('aria-controls');
    expect(document.getElementById(controls ?? ''), `aria-controls="${controls}" points at nothing`).not.toBeNull();
  });

  it('reaches the commit SHA, pull request number or tracker key in one click', () => {
    const { before, after } = mixedPair();
    document.body.innerHTML = render(before, after);

    const artifactLinks = [...document.body.querySelectorAll('a[href^="/artifact/"]')];
    expect(artifactLinks.length, 'no claim links to its source artifact').toBeGreaterThan(0);

    for (const link of artifactLinks) {
      // One click: a real in-app href, not a JavaScript affordance and not an external redirect.
      expect(link.getAttribute('href')).toMatch(/^\/artifact\/[^/]+\/[^/]+$/);
      expect((link.textContent ?? '').trim().length, 'an artifact link with no name').toBeGreaterThan(0);
    }
  });

  it('links a changed item to its evidence on both sides of the diff', () => {
    /**
     * Criterion 002: "every changed item links to its evidence affordance in both reports". A changed
     * row has two claims and each carries its own payload panel and its own artifact links, so a
     * reviewer can check the *before* as well as the after — which is the whole point when the question
     * is whether a number moved or was invented.
     */
    const { before, after } = mixedPair();
    document.body.innerHTML = render(before, after);

    const changedRow = document.body.querySelector('[data-diff-row="changed"]');
    expect(changedRow, 'there is no changed row to check').not.toBeNull();

    const panels = [...(changedRow?.querySelectorAll('details') ?? [])];
    expect(panels, 'a changed row must expose both sides’ payloads').toHaveLength(2);

    for (const panel of panels) {
      expect(
        panel.querySelectorAll('a[href^="/artifact/"]').length,
        'one side of a changed row has no evidence link',
      ).toBeGreaterThan(0);
    }
  });

  it('gives the two sides distinct panel ids, so aria-controls is unambiguous', () => {
    const { before, after } = mixedPair();
    document.body.innerHTML = render(before, after);

    const ids = [...document.body.querySelectorAll('summary[aria-controls]')].map((node) =>
      node.getAttribute('aria-controls'),
    );

    // Duplicate ids would make every `aria-controls` on the page resolve to the first panel.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('states the absence rather than an empty panel when a claim has no payload', () => {
    const base = earlier();
    const stripped = withFirstSectionItems(storedBundle(), (items) =>
      items.map((entry) => ({ ...entry, payload: {}, severityScore: entry.severityScore + 5 })),
    );

    document.body.innerHTML = render(base, stripped);
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('carries no structured payload of its own');
  });
});

describe('the diff is reachable from the archive', () => {
  /**
   * A comparison view nobody can navigate to is the defect a previous task found on `/me`: the
   * permission was right, the route worked, and the only way in was to type the URL. So the archive
   * index carries a link per team row, and this asserts it — including the case where there is nothing
   * to compare against.
   */
  const days = [
    {
      reportDate: '2026-07-31',
      entries: [
        {
          reportId: 'r-platform-31',
          scopeLabel: 'platform',
          scopeKind: 'team',
          scopeKey: 'platform',
          reportDate: '2026-07-31',
          href: '/archive/r-platform-31',
          itemCount: 3,
          coverageStatus: 'complete',
          fallbackRenderer: false,
          generatedAtLabel: '31 July 2026, 06:00',
        },
      ],
    },
    {
      reportDate: '2026-07-29',
      entries: [
        {
          reportId: 'r-platform-29',
          scopeLabel: 'platform',
          scopeKind: 'team',
          scopeKey: 'platform',
          reportDate: '2026-07-29',
          href: '/archive/r-platform-29',
          itemCount: 2,
          coverageStatus: 'complete',
          fallbackRenderer: false,
          generatedAtLabel: '29 July 2026, 06:00',
        },
      ],
    },
  ];

  it('offers a “what changed” link against the previous report for that team', () => {
    document.body.innerHTML = renderToStaticMarkup(<ArchiveIndex days={days} />);

    const link = [...document.body.querySelectorAll('a')].find((anchor) =>
      (anchor.textContent ?? '').includes('what changed'),
    );

    expect(link, 'the archive offers no way into the diff').toBeDefined();
    // The previous date *for that team* — 29 July, skipping the 30th which has no platform report.
    expect(link?.getAttribute('href')).toBe('/archive/diff?team=platform&from=2026-07-29&to=2026-07-31');
  });

  it('names the two dates for a screen reader rather than repeating a bare “what changed”', () => {
    document.body.innerHTML = renderToStaticMarkup(<ArchiveIndex days={days} />);

    const link = [...document.body.querySelectorAll('a')].find((anchor) =>
      (anchor.textContent ?? '').includes('what changed'),
    );

    // Several rows carry this link, so the accessible name has to distinguish them.
    expect((link?.textContent ?? '').replace(/\s+/g, ' ')).toContain('platform between 2026-07-29 and 2026-07-31');
  });

  it('offers no link on the oldest report, which has nothing to compare against', () => {
    document.body.innerHTML = renderToStaticMarkup(<ArchiveIndex days={days} />);

    const links = [...document.body.querySelectorAll('a')].filter((anchor) =>
      (anchor.textContent ?? '').includes('what changed'),
    );

    // A link to a comparison that cannot exist would land the reader on the missing-report state and
    // teach them the feature is broken.
    expect(links).toHaveLength(1);
  });
});

describe('the page reads from storage, and says so', () => {
  it('tells the reviewer nothing was regenerated', () => {
    const { before, after } = mixedPair();
    const text = textOf(render(before, after));

    // The claim the whole view rests on: if either column were regenerated, a fabricated item would be
    // regenerated identically and look confirmed.
    expect(text).toContain('Nothing on this page was regenerated');
  });

  it('links to both stored reports so either can be read whole', () => {
    const { before, after } = mixedPair();
    document.body.innerHTML = render(before, after);

    const hrefs = [...document.body.querySelectorAll('a[href^="/archive/"]')].map((node) =>
      node.getAttribute('href'),
    );

    expect(hrefs).toContain('/archive/report-0');
    expect(hrefs).toContain('/archive/report-1');
  });

  it('shows the stable id on every row, which is what the diff is keyed on', () => {
    /**
     * The id is printed because it is the thing the diff is keyed on: a reviewer arguing that two rows
     * are "the same item" needs to see what Compass matched them by. It is labelled for a screen reader
     * rather than left as a bare mono string.
     *
     * Asserted against the ids the two bundles actually carry, not against a guessed prefix — the
     * fixture's ids are `blocker:ticket:DEV-522:tracker_flag`, keyed on the *cause family* rather than
     * on the section, which is exactly why the engine keys on `stableId` and never on position.
     */
    const { before, after } = mixedPair();
    const view = buildReportDiffView({ before, after });
    document.body.innerHTML = render(before, after);

    const rows = [...document.body.querySelectorAll('[data-diff-row]')];
    expect(rows.length).toBe(view.sections.reduce((sum, section) => sum + section.rows.length, 0));

    const renderedIds = view.sections.flatMap((section) => section.rows.map((row) => row.stableId));
    for (const row of rows) {
      const text = (row.textContent ?? '');
      expect(text).toContain('Stable id:');
      expect(
        renderedIds.some((id) => text.includes(id)),
        'a row printed no stable id from either report',
      ).toBe(true);
    }
  });
});
