import type { FreshnessView } from '../lib/view-model';

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
                {!source.answered && <span className="stated-absence pl-[18px] text-[13px]">{source.detail}</span>}
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
    </section>
  );
}
