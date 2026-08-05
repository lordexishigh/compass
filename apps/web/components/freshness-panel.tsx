import type { FreshnessView } from '../lib/view-model';

/**
 * What a source of each kind would have contributed, had it answered.
 *
 * Naming the source is not the whole of the criterion — "`legacy-code` returned 429" tells a manager
 * something is missing without telling them *what*. A reader deciding whether to trust this morning's
 * report needs to know that the silent source is the one that would have carried the merges, because
 * that is what tells them which of the six sections is thin.
 *
 * Keyed on `sourceKind` rather than on the source key, because the kind is the provider-neutral fact
 * the port already guarantees — `code`, `tracker`, `chat` — and a map keyed on `github` or `jira`
 * would need an entry per provider Compass ever adds. The kind was already on
 * `FreshnessSourceView` and was never rendered; this is the consumer it was fetched for.
 */
const CONTRIBUTION_OF: Readonly<Record<string, string>> = {
  code: 'commits, pull requests, reviews and release tags',
  tracker: 'tickets, their status changes and sprint scope',
  chat: 'the discussion that names blockers',
};

/** Deliberately not a fallback sentence: an unknown kind states the honest shape of the gap. */
const contributionOf = (sourceKind: string): string =>
  CONTRIBUTION_OF[sourceKind] ?? `whatever this ${sourceKind} source carries`;

/**
 * What was ingested, when, and from where — per source, from `IngestRun` rows.
 *
 * The rule this component exists to keep is negative. **No fabricated freshness
 * value.** If the journal holds no run, there is no "last updated" to show and
 * the panel says so; it never falls back to the report's own generation time,
 * which would tell a manager the *data* is fresh when what is fresh is the page.
 *
 * A source that answered nothing is marked missing and, in the same breath, the
 * report is marked not complete. Those two must move together: a page that
 * listed a dead source in small grey type and still read as finished is exactly
 * the quiet dishonesty this product is meant to replace.
 */
export function FreshnessPanel({ freshness }: { readonly freshness: FreshnessView }) {
  return (
    <section aria-labelledby="freshness-heading" className="mt-4 text-[13px] leading-relaxed text-ink-faint">
      <h2 id="freshness-heading" className="sr-only">
        Data freshness and coverage
      </h2>

      <p
        data-testid="coverage-statement"
        data-complete={freshness.complete ? 'true' : 'false'}
        className={freshness.complete ? '' : 'stated-absence text-[13px]'}
      >
        {freshness.statement}
      </p>

      {freshness.hasIngestRecord ? (
        <>
          <p className="mt-1 font-mono tabular-nums">
            <span>
              last ingest {freshness.lastIngestLabel ?? 'not recorded'}
            </span>
            {freshness.runWindowLabel !== null && (
              <>
                <span aria-hidden="true"> · </span>
                <span>window {freshness.runWindowLabel}</span>
              </>
            )}
          </p>

          <ul className="mt-3 space-y-2">
            {freshness.sources.map((source) => (
              <li key={source.sourceKey} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span
                    className={[
                      'inline-block h-[3px] w-[10px] rounded-[1px]',
                      source.answered ? 'bg-verified' : 'bg-rule-strong',
                    ].join(' ')}
                    aria-hidden="true"
                  />
                  <span className="data-token">{source.sourceKey}</span>
                  <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                    {source.answered ? `${source.recordCount} records` : 'no data'}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                    {source.lastIngestLabel === null
                      ? 'never answered'
                      : `last ${source.lastIngestLabel}`}
                  </span>
                </span>
                <span className="pl-[18px] font-mono text-[11px] tabular-nums text-ink-faint">
                  covered {source.coveredLabel ?? 'nothing of'} {source.coveredLabel === null ? source.windowLabel : ''}
                </span>
                {!source.answered && (
                  <>
                    <span className="stated-absence pl-[18px] text-[13px]">{source.detail}</span>
                    {/*
                      The other half of the disclosure: which source, *and* what is therefore absent
                      from the report above. Set in the same stated-absence voice as the reason, so
                      the two read as one sentence about a gap rather than a reason and a footnote.
                    */}
                    <span data-testid="missing-contribution" className="stated-absence pl-[18px] text-[13px]">
                      Without it this report is missing {contributionOf(source.sourceKind)}.
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="stated-absence mt-1 text-[13px]">
          Nothing has been written to the ingest journal for this organization, so there is no per-source freshness to
          show. Compass leaves this blank rather than filling it with the time the page was rendered.
        </p>
      )}

      {/*
        Disconnected sources, stated beside the journal's own rows.

        A separate list rather than an extra row in the one above, because these two facts come from
        different places and only one of them is in the journal. A source nobody is reading contributes no
        coverage row at all — so on the journal's evidence it simply is not there, which renders exactly
        like a source that was never configured. Printing it from the configuration is what makes
        "disconnected" something the page says rather than something a reader has to notice.

        Set in the same stated-absence voice as a missing source, and never colour-coded: this is not bad
        news, it is a fact about what a manager chose.
      */}
      {freshness.disconnected.length > 0 && (
        <ul className="mt-3 space-y-2" data-testid="disconnected-sources">
          {freshness.disconnected.map((source) => (
            <li key={source.sourceKey} className="flex flex-col gap-0.5" data-source-key={source.sourceKey}>
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="inline-block h-[3px] w-[10px] rounded-[1px] bg-rule-strong" aria-hidden="true" />
                <span className="data-token">{source.sourceKey}</span>
                <span className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">disconnected</span>
              </span>
              <span data-testid="disconnected-statement" className="stated-absence pl-[18px] text-[13px]">
                {source.statement}
              </span>
              <span className="stated-absence pl-[18px] text-[13px]">
                Without it this report is missing {contributionOf(source.sourceKind)}.
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
