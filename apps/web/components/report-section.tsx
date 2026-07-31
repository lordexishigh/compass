import type { ClaimView, SectionView } from '../lib/view-model';

import { AlignmentEvidence } from './alignment-evidence';
import { CompletionLadder } from './completion-ladder';
import { EvidenceChain, EvidenceMarkers } from './evidence-markers';

/**
 * One of the six sections.
 *
 * The text shown is the deterministic renderer's own prose, not a re-derivation
 * from the item fields. That matters for one reason: the renderer's hard rule is
 * that no quantity appears without a clause interpreting it, and a view that
 * printed `item.headline` instead would print "Sprint 43 is 62% complete" with
 * the pace clause stripped off — the exact bare metric the rule exists to
 * prevent. So the page renders what the renderer wrote, and inherits the rule.
 *
 * Items are separated by space and a hairline — no cards, no fills, no shadows
 * in the reading column. An empty section states its absence as a sentence.
 */
export function ReportSectionBlock({ section }: { readonly section: SectionView }) {
  return (
    <section id={`section-${section.key}`} aria-labelledby={`heading-${section.key}`} className="scroll-mt-20">
      <h2 id={`heading-${section.key}`} className="section-label flex items-baseline gap-2">
        <span className="font-mono tabular-nums">{section.numeral}</span>
        <span>{section.title}</span>
      </h2>

      {section.items.length === 0 ? (
        <p className="stated-absence mt-3 text-[17px] leading-relaxed">
          {section.prose.length > 0 ? section.prose : section.emptyStatement}
        </p>
      ) : (
        <>
          <p className="prose-narration mt-3 text-ink-muted">{section.summary ?? section.title}</p>
          <ul className="mt-5 space-y-6">
            {section.items.map((item) => (
              <li key={item.stableId}>
                <ReportClaim item={item} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * One claim: its sentences, its elapsed sigil, its notches and its evidence.
 *
 * The day counter is a pill rather than a badge saying NEW, and the change since
 * yesterday is a run-in italic clause, because "this is day 6 of the same
 * blocker" is a fact a manager can act on and "NEW" is decoration.
 *
 * An alignment claim gets one thing more: the resolution path, one click away. The
 * question an unattributed item asks is printed in serif italic above it, because a
 * question Compass is asking must read as a question and not as a finding with a
 * footnote.
 */
function ReportClaim({ item }: { readonly item: ClaimView }) {
  const sentences = item.prose.length > 0 ? item.prose : `${item.headline}. ${item.detail}`.trim();

  return (
    <article className="border-l border-rule-strong pl-4">
      <p className="prose-narration">
        {sentences}
        <EvidenceMarkers evidence={item.evidence} />
        {item.ageDays > 0 && (
          <span className="ml-2 inline-flex items-baseline rounded-[4px] border border-rule-strong px-1.5 py-px font-mono text-[11px] not-italic tabular-nums text-ink-muted">
            day {item.ageDays}
          </span>
        )}
      </p>

      {item.alignment?.question !== null && item.alignment?.question !== undefined && (
        <p className="alignment-question">{item.alignment.question}</p>
      )}

      {item.ladder !== null && <CompletionLadder ladder={item.ladder} />}
      <EvidenceChain evidence={item.evidence} />
      {item.alignment !== null && <AlignmentEvidence alignment={item.alignment} />}
    </article>
  );
}
