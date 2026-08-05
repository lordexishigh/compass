import Link from 'next/link';

import type { DiffClaimView, DiffRowView, DiffSectionView, ReportDiffView } from '../lib/diff-source';
import { EvidenceChain } from './evidence-markers';

/**
 * The side-by-side diff: two mornings, one reading column each, and what moved between them.
 *
 * ## Why there is no red and no green
 *
 * Every diff tool colours additions green and deletions red, and this one deliberately does not.
 * Compass rations colour to two meanings — emerald for verified positive fact, teal for the manager's
 * own authorship — and it never colour-codes bad news. An item *leaving* the report is usually good
 * (a blocker cleared) and an item *appearing* is usually bad, so the conventional palette would be
 * exactly backwards half the time while looking authoritative.
 *
 * So status is carried the way severity is carried everywhere else in this product: a mono glyph, a
 * word, weight, and rule thickness. `+ appeared`, `− left the report`, `~ changed`. It reads as a
 * document rather than a diff viewer, which is the point.
 *
 * ## No client JavaScript
 *
 * Every control here is a link or a native `<details>`. The jump-to-next-change control is a set of
 * anchors, not a scroll handler; the claim expansion is a disclosure, not a modal. That is the same
 * choice `AlignmentEvidence` makes and for the same reason: the fabrication check has to work for a
 * reviewer opening a link on a phone with battery saver on, and it has to be present in the static
 * HTML so the smoke test can see it.
 */

/** The three markers, and the one place their wording is decided. */
const STATUS_MARK: Readonly<Record<DiffRowView['status'], { glyph: string; label: string }>> = {
  added: { glyph: '+', label: 'appeared' },
  removed: { glyph: '−', label: 'left the report' },
  changed: { glyph: '~', label: 'changed' },
  unchanged: { glyph: '·', label: 'unchanged' },
};

function StatusMark({ status }: { readonly status: DiffRowView['status'] }) {
  const mark = STATUS_MARK[status];
  const emphasised = status !== 'unchanged';

  return (
    <span
      data-diff-status={status}
      className={[
        'inline-flex items-baseline gap-1.5 font-mono text-[11px] tabular-nums',
        emphasised ? 'text-ink-strong' : 'text-ink-faint',
      ].join(' ')}
    >
      <span aria-hidden="true" className={emphasised ? 'font-semibold' : ''}>
        {mark.glyph}
      </span>
      <span>{mark.label}</span>
    </span>
  );
}

/**
 * The structured payload behind one claim, beside the prose a manager read.
 *
 * This is the fabrication check. A reviewer expands a claim and sees, in one place: the sentences
 * Compass printed, every field of the payload those sentences were composed from, and a link to each
 * source artifact. A token in the prose that appears in no payload field and no artifact is a
 * fabrication, and this view is what makes that statement checkable rather than asserted.
 *
 * A native `<details>`, closed by default so the columns stay readable, and announced as a disclosure
 * with a name that says what opening it will show.
 */
function ClaimPayload({ claim, side }: { readonly claim: DiffClaimView; readonly side: string }) {
  const panelId = `payload-${side}-${claim.stableId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;

  return (
    <details className="group mt-3">
      <summary
        aria-controls={panelId}
        className="cursor-pointer list-none font-mono text-[11px] text-ink-muted underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <span aria-hidden="true" className="mr-1 inline-block transition-transform duration-150 group-open:rotate-90">
          ›
        </span>
        What Compass computed this from — {claim.payloadFields.length} payload{' '}
        {claim.payloadFields.length === 1 ? 'field' : 'fields'}
        {claim.evidence.length > 0 ? `, ${claim.evidence.length} artifact${claim.evidence.length === 1 ? '' : 's'}` : ''}
      </summary>

      <div id={panelId} className="mt-3 border-l border-rule pl-3">
        <p className="text-[13px] italic leading-relaxed text-ink-muted">
          The prose above is composed from these fields. Nothing in it originates here.
        </p>

        {claim.payloadFields.length === 0 ? (
          <p className="stated-absence mt-2 text-[13px]">
            This claim carries no structured payload of its own — its evidence is the artifacts below.
          </p>
        ) : (
          <dl className="mt-2 space-y-1.5">
            {claim.payloadFields.map((field) => (
              <div key={field.field} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <dt className="data-token shrink-0 font-mono text-[11px] sm:w-40">{field.field}</dt>
                <dd className="break-words font-mono text-[11px] leading-relaxed text-ink-muted">{field.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {/* One click from here to the commit SHA, pull request number or tracker key. */}
        <EvidenceChain evidence={claim.evidence} />
      </div>
    </details>
  );
}

/** One report's side of a row: the prose as printed, then the payload behind it. */
function ClaimColumn({
  claim,
  side,
  absenceStatement,
}: {
  readonly claim: DiffClaimView | null;
  readonly side: string;
  readonly absenceStatement: string;
}) {
  if (claim === null) {
    // A stated absence, not an empty cell. An empty column would read as a rendering fault.
    return (
      <div className="stated-absence text-[13px] leading-relaxed" data-diff-absent="true">
        {absenceStatement}
      </div>
    );
  }

  return (
    <div>
      <p className="text-[15px] leading-relaxed text-ink">{claim.prose}</p>

      {claim.changeClause !== null && (
        <p className="mt-1 font-serif text-[13px] italic leading-relaxed text-ink-muted">
          —— {claim.changeClause}
        </p>
      )}

      <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-faint">
        <span>day {claim.ageDays}</span>
        <span aria-hidden="true"> · </span>
        <span>severity {claim.severityScore}</span>
        <span aria-hidden="true"> · </span>
        <span>{claim.changeTag}</span>
      </p>

      <ClaimPayload claim={claim} side={side} />
    </div>
  );
}

/**
 * The fields that moved on a changed claim, named with both values.
 *
 * Printed rather than left to the reader to spot by comparing two paragraphs: "severity went from 30
 * to 45" is the fact, and making somebody diff prose by eye to find it is how a real change gets
 * missed among four unchanged sentences.
 */
function ChangedFields({ row }: { readonly row: DiffRowView }) {
  if (row.changedFields.length === 0) return null;

  return (
    <dl className="mt-3 space-y-1 border-t border-rule pt-2">
      {row.changedFields.map((change) => (
        <div key={change.field} className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]">
          <dt className="data-token">{change.field}</dt>
          <dd className="text-ink-muted">
            <span className="line-through decoration-rule-strong">{change.before}</span>
            <span aria-hidden="true" className="mx-1">
              →
            </span>
            <span className="sr-only"> became </span>
            <span className="text-ink-strong">{change.after}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DiffRow({
  row,
  diff,
  nextAnchor,
}: {
  readonly row: DiffRowView;
  readonly diff: ReportDiffView;
  readonly nextAnchor: string | null;
}) {
  const changed = row.status !== 'unchanged';

  return (
    <li
      id={row.anchorId}
      data-diff-row={row.status}
      // A changed row is marked by a thicker left rule, not by a colour. `scroll-mt` keeps the row
      // clear of the sticky header when the jump control lands on it.
      className={[
        'scroll-mt-24 border-l py-4 pl-3 sm:pl-4',
        changed ? 'border-l-2 border-rule-severe' : 'border-rule',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <StatusMark status={row.status} />

        <span className="font-mono text-[10px] text-ink-faint">
          <span className="sr-only">Stable id: </span>
          {row.stableId}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
        {/*
          Stacked on a phone, side by side from `md`. A true two-column diff at 375px would give each
          column 170px, which is four words a line — so the earlier report sits above the later one,
          each labelled, and the reading order is the same one the columns have on a desktop.
        */}
        <div>
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
            {diff.left.reportDate}
          </p>
          <ClaimColumn
            claim={row.before}
            side="before"
            absenceStatement={`Not in the ${diff.left.reportDate} report — this claim appeared on ${diff.right.reportDate}.`}
          />
        </div>

        <div className="border-t border-rule pt-4 md:border-l md:border-t-0 md:pl-6 md:pt-0">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
            {diff.right.reportDate}
          </p>
          <ClaimColumn
            claim={row.after}
            side="after"
            absenceStatement={`No longer in the report on ${diff.right.reportDate}. It was present on ${diff.left.reportDate}.`}
          />
        </div>
      </div>

      <ChangedFields row={row} />

      {nextAnchor !== null && (
        <p className="mt-3">
          <Link
            href={`#${nextAnchor}`}
            className="font-mono text-[11px] text-verified-text underline decoration-transparent underline-offset-4 transition-colors duration-150 hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Next change ↓
          </Link>
        </p>
      )}
    </li>
  );
}

function DiffSection({
  section,
  diff,
}: {
  readonly section: DiffSectionView;
  readonly diff: ReportDiffView;
}) {
  const headingId = `diff-section-${section.key}`;
  const anchors = diff.changeAnchors;

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="flex items-baseline gap-3">
        <span aria-hidden="true" className="font-mono text-[11px] tabular-nums text-ink-faint">
          {section.numeral}
        </span>
        <span className="text-[17px] font-medium tracking-tight text-ink-strong">{section.title}</span>
        <span className="font-mono text-[11px] tabular-nums text-ink-faint">
          {section.hasChanges
            ? [
                section.addedCount > 0 ? `+${section.addedCount}` : null,
                section.removedCount > 0 ? `−${section.removedCount}` : null,
                section.changedCount > 0 ? `~${section.changedCount}` : null,
              ]
                .filter((part) => part !== null)
                .join(' ')
            : 'no change'}
        </span>
      </h2>

      {section.rows.length === 0 ? (
        <p className="stated-absence mt-3 text-[13px]">
          Neither report carried anything in {section.title}.
        </p>
      ) : (
        <ul className="mt-2">
          {section.rows.map((row) => {
            // The next change *after this row*, so the control walks the same order the page renders.
            const position = anchors.indexOf(row.anchorId);
            const nextAnchor =
              position === -1 || position + 1 >= anchors.length ? null : anchors[position + 1]!;

            return <DiffRow key={row.anchorId} row={row} diff={diff} nextAnchor={nextAnchor} />;
          })}
        </ul>
      )}
    </section>
  );
}

export function ReportDiffDocument({ diff }: { readonly diff: ReportDiffView }) {
  const firstChange = diff.changeAnchors[0] ?? null;

  return (
    <main id="diff" className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
          What changed since {diff.left.reportDate}
        </p>
        <h1 className="mt-2 text-[22px] font-medium tracking-tight text-ink-strong">
          {diff.left.teamLabel} — {diff.left.reportDate} beside {diff.right.reportDate}
        </h1>

        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink">{diff.statement}</p>

        <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-faint">
          <span>
            +{diff.addedCount} appeared
          </span>
          <span aria-hidden="true"> · </span>
          <span>−{diff.removedCount} left</span>
          <span aria-hidden="true"> · </span>
          <span>~{diff.changedCount} changed</span>
          <span aria-hidden="true"> · </span>
          <span>{diff.unchangedCount} unchanged</span>
        </p>

        <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
          Both columns are read from the stored reports, exactly as they were written. Nothing on this
          page was regenerated — expand any claim to see the payload it was computed from.
        </p>

        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
          <Link
            href={diff.left.href}
            className="text-verified-text underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Open the {diff.left.reportDate} report
          </Link>
          <Link
            href={diff.right.href}
            className="text-verified-text underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Open the {diff.right.reportDate} report
          </Link>
        </p>
      </header>

      {/*
        The jump control. A link rather than a scroll handler, so it needs no client bundle, works
        from the keyboard for free, and is a real target a screen reader announces.
      */}
      {firstChange !== null && (
        <nav
          aria-label="Changes"
          className="sticky top-0 z-10 mt-6 -mx-4 border-y border-rule bg-surface/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6"
        >
          <Link
            href={`#${firstChange}`}
            className="font-mono text-[11px] text-verified-text underline decoration-transparent underline-offset-4 transition-colors duration-150 hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Jump to the first of {diff.changeAnchors.length}{' '}
            {diff.changeAnchors.length === 1 ? 'change' : 'changes'} ↓
          </Link>
        </nav>
      )}

      {diff.reportFieldChanges.length > 0 && (
        <section aria-labelledby="diff-report-level" className="mt-8 border-l-2 border-rule-severe pl-3 sm:pl-4">
          <h2 id="diff-report-level" className="text-[15px] font-medium tracking-tight text-ink-strong">
            Report-level figures that moved
          </h2>
          <dl className="mt-2 space-y-1">
            {diff.reportFieldChanges.map((change) => (
              <div key={change.field} className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]">
                <dt className="data-token">{change.field}</dt>
                <dd className="text-ink-muted">
                  <span className="line-through decoration-rule-strong">{change.before}</span>
                  <span aria-hidden="true" className="mx-1">
                    →
                  </span>
                  <span className="sr-only"> became </span>
                  <span className="text-ink-strong">{change.after}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/*
        The "nothing changed" state, stated rather than left as two identical columns.
        Criterion 002: a reader who scrolls two identical reports and is told nothing has learned
        nothing about whether the diff worked.
      */}
      {!diff.hasChanges ? (
        <section aria-labelledby="diff-nothing-changed" className="mt-10 border-l border-rule pl-4">
          <h2 id="diff-nothing-changed" className="text-[17px] font-medium tracking-tight text-ink-strong">
            Nothing material changed
          </h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink">{diff.statement}</p>
          <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
            The two reports are not being hidden from you — every item below carries the same stable id,
            the same evidence and the same severity in both. Compass says so here rather than printing
            two identical columns and leaving you to compare {diff.unchangedCount} items by eye.
          </p>
          <p className="mt-3 font-mono text-[11px] tabular-nums text-ink-faint">
            {diff.unchangedCount} {diff.unchangedCount === 1 ? 'item' : 'items'} identical in both reports
          </p>
        </section>
      ) : (
        diff.sections.map((section) => <DiffSection key={section.key} section={section} diff={diff} />)
      )}
    </main>
  );
}
