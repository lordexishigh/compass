import type { CalibrationCollarView } from '../lib/view-model';

/** The attribute the smoke test and the view test count. One per report, or none. */
export const COLLAR_ATTRIBUTE = 'data-calibration-collar';

/**
 * The confidence collar, and the Process Calibration Audit under it.
 *
 * The projected date is the most authoritative-looking object in the report: square
 * brackets, mono, 22px, once per page. This component's job is to stop a manager
 * reading it as a promise — so it is deliberately built as *two lines that undercut
 * the line above them*:
 *
 *  - line one, the confidence band and the method it came from;
 *  - line two, the calibration verdict in the product's own plain voice, in zinc-600
 *    serif italic — *"your points haven't tracked elapsed days for four sprints, so
 *    this date is a cycle-time guess"*.
 *
 * And when calibration is poor the date itself is set in `ink-faint` rather than
 * `ink-strong`, so **the typography loses conviction along with the prose**. That is
 * the whole point of the object: a page whose type stays confident while its words
 * withdraw has overruled its own words, and the reader will believe the type.
 *
 * The audit's verdicts follow as a definition list — each one naming its statistic's
 * value and the numbered threshold it was compared against, because "scope is
 * fiction" is an accusation until it is `0.50 against T19's 0.30`, at which point it
 * is an argument a manager can win.
 *
 * No colour is used to mark bad news. Emerald appears only on the *absence* of
 * findings, which is a verified positive fact; everything else is carried by zinc,
 * weight and rule thickness, exactly as the palette rations it.
 */
export function CalibrationCollar({ collar }: { readonly collar: CalibrationCollarView | null }) {
  if (collar === null) {
    return (
      <p className="stated-absence mt-6 text-[13px]">
        This report was written before Compass audited the data behind it, so there is no calibration verdict to show.
      </p>
    );
  }

  const clean = collar.verdicts.length === 0;

  return (
    <section
      {...{ [COLLAR_ATTRIBUTE]: 'true' }}
      aria-labelledby="collar-heading"
      className="hairline mt-8 pt-6"
    >
      <h2 id="collar-heading" className="section-label">
        Projected completion
      </h2>

      {collar.projectedDate === null ? (
        <p className="mt-3 font-mono text-[22px] leading-none tracking-tight text-ink-faint">
          <span aria-hidden="true">[</span>
          <span className="text-[15px] tracking-normal">no date</span>
          <span aria-hidden="true">]</span>
        </p>
      ) : (
        <p
          className={[
            'mt-3 font-mono text-[22px] leading-none tabular-nums tracking-tight',
            collar.lowConviction ? 'text-ink-faint' : 'text-ink-strong',
          ].join(' ')}
        >
          <span aria-hidden="true">[</span>
          {collar.projectedDate}
          <span aria-hidden="true">]</span>
        </p>
      )}

      {/* Line one: the band and the method. */}
      {collar.bandStatement.length > 0 && (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
          {collar.bandStatement}
          {collar.confidence !== null && (
            <>
              {' '}
              <span className="data-token">{collar.confidence} confidence</span>
            </>
          )}
        </p>
      )}

      {/* Line two: the verdict, allowed to undercut the number above it. */}
      {collar.calibrationStatement.length > 0 && (
        <p className="mt-1 font-serif text-[14px] italic leading-relaxed text-ink-muted">
          {collar.calibrationStatement}
        </p>
      )}

      {collar.selectedByVerdicts.length > 0 && (
        <p className="mt-2 text-[13px] leading-relaxed text-ink-faint">
          Method chosen by{' '}
          {collar.selectedByVerdicts.map((name, index) => (
            <span key={name}>
              {index > 0 && ', '}
              <span className="data-token">{name}</span>
            </span>
          ))}
          .
        </p>
      )}

      <h3 className="section-label mt-6">Process calibration audit</h3>
      <p className="mt-2 font-serif text-[14px] italic leading-relaxed text-ink-muted">{collar.auditStatement}</p>

      {clean ? (
        <p className="mt-3 text-[13px] leading-relaxed text-verified-text">
          Nothing in the data behind this report crossed a calibration threshold.
        </p>
      ) : (
        <dl className="mt-4 space-y-4">
          {collar.verdicts.map((verdict) => (
            <div key={verdict.name} className="border-l border-rule-strong pl-4">
              <dt className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[15px] font-medium text-ink-strong">{verdict.label}</span>
                <span className="data-token text-ink-muted">
                  {verdict.valueLabel}
                  {verdict.thresholdLabel.length > 0 && (
                    <>
                      {' vs '}
                      {verdict.thresholdLabel}
                    </>
                  )}
                </span>
                {verdict.thresholdId.length > 0 && (
                  <span className="inline-flex items-baseline rounded-[4px] border border-rule-strong px-1.5 py-px font-mono text-[11px] tabular-nums text-ink-faint">
                    {verdict.thresholdId}
                  </span>
                )}
                {verdict.sampleSize > 0 && (
                  <span className="font-mono text-[11px] tabular-nums text-ink-faint">n={verdict.sampleSize}</span>
                )}
              </dt>
              <dd className="prose-narration mt-1 text-[14px]">{verdict.statement}</dd>
            </div>
          ))}
        </dl>
      )}

      {collar.suppressed.length > 0 && (
        <p className="stated-absence mt-4 text-[13px]">
          Compass is withholding{' '}
          {collar.suppressed.map((name, index) => (
            <span key={name}>
              {index > 0 && ' and '}
              <span className="data-token">{name}</span>
            </span>
          ))}{' '}
          — neither can be measured without trailing sprints.
        </p>
      )}
    </section>
  );
}
