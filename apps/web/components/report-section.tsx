import type { ReportItem, ReportSection } from '@compass/analysis';

export interface ReportSectionBlockProps {
  readonly section: ReportSection;
  readonly numeral: string;
}

/**
 * One of the six sections. Items are separated by space and a hairline rule —
 * no cards, no fills, no shadows in the reading column. An empty section states
 * its absence as a sentence rather than rendering a blank.
 */
export function ReportSectionBlock({ section, numeral }: ReportSectionBlockProps) {
  return (
    <section id={`section-${section.key}`} aria-labelledby={`heading-${section.key}`} className="scroll-mt-20">
      <h2 id={`heading-${section.key}`} className="section-label flex items-baseline gap-2">
        <span className="font-mono tabular-nums">{numeral}</span>
        <span>{section.title}</span>
      </h2>

      {section.items.length === 0 ? (
        <p className="stated-absence mt-3 text-[17px] leading-relaxed">{section.emptyStatement}</p>
      ) : (
        <ul className="mt-4 space-y-6">
          {section.items.map((item) => (
            <li key={item.stableId}>
              <ReportItemBody item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReportItemBody({ item }: { readonly item: ReportItem }) {
  return (
    <article className="border-l border-rule-strong pl-4">
      <p className="prose-narration">
        {item.headline}
        {item.ageDays > 0 && (
          <span className="ml-2 inline-flex items-baseline rounded-[4px] border border-rule-strong px-1.5 py-px font-mono text-[11px] not-italic tabular-nums text-ink-muted">
            day {item.ageDays}
          </span>
        )}
      </p>
      {item.detail.length > 0 && <p className="prose-narration mt-1 text-ink-muted">{item.detail}</p>}
      {item.evidence.length > 0 && (
        <p className="mt-2 text-[13px] text-ink-faint">
          {item.evidence.map((reference, index) => (
            <span key={`${reference.sourceKey}:${reference.sourceRecordId}`}>
              {index > 0 && <span aria-hidden="true"> · </span>}
              <span className="data-token">{reference.label}</span>
            </span>
          ))}
        </p>
      )}
    </article>
  );
}
