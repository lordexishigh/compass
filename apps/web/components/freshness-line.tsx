import type { ReportCoverageNote } from '@compass/analysis';

export interface FreshnessLineProps {
  readonly notes: readonly ReportCoverageNote[];
  readonly observedAt: string;
  readonly windowLabel: string;
}

/**
 * The freshness line, under the masthead: what was ingested, when, and what was
 * not. A stale or disconnected source is named in plain words rather than
 * hidden, so the report is never presented as complete when it isn't.
 */
export function FreshnessLine({ notes, observedAt, windowLabel }: FreshnessLineProps) {
  const healthy = notes.filter((note) => note.status === 'complete');
  const degraded = notes.filter((note) => note.status !== 'complete');

  return (
    <div className="mt-4 text-[13px] leading-relaxed text-ink-faint">
      <p className="font-mono tabular-nums">
        <span>Observed {observedAt}</span>
        <span aria-hidden="true"> · </span>
        <span>window {windowLabel}</span>
      </p>
      <p className="mt-1">
        {healthy.length > 0 ? (
          <span>
            Reading{' '}
            <span className="font-mono tabular-nums text-ink-muted">
              {healthy.map((note) => note.sourceKey).join(', ')}
            </span>
          </span>
        ) : (
          <span>No source answered for this window.</span>
        )}
      </p>
      {degraded.length > 0 && (
        <ul className="mt-1 space-y-1">
          {degraded.map((note) => (
            <li key={note.sourceKey} className="stated-absence text-[13px]">
              <span className="font-mono not-italic text-ink-muted underline decoration-rule-strong underline-offset-4">
                {note.sourceKey}
              </span>{' '}
              — {note.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
