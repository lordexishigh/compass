import type { ClaimView, SectionView } from '../lib/view-model';

import { AlignmentEvidence } from './alignment-evidence';
import { CompletionLadder } from './completion-ladder';
import { EvidenceChain, EvidenceMarkers } from './evidence-markers';
import { ProseBlock } from './prose-block';

/**
 * One of the six sections, in either of the two voices it can be written in.
 *
 * **Templated.** The deterministic renderer emits one paragraph per claim, so each
 * claim is rendered with its own sentences and its evidence marker attached to them.
 * The renderer's hard rule — no quantity without a clause interpreting it — lives in
 * those sentences, which is why the page shows `item.prose` rather than
 * `item.headline`: printing the headline would print `Sprint 43 is 62% complete`
 * with the pace clause stripped off.
 *
 * **Narrated.** A model was free to reorder and merge the items, so per-claim
 * paragraphs no longer exist and per-claim prose can no longer be attributed. The
 * section's prose becomes the read, and each claim renders beneath it as its
 * *receipts*: the notches, the day counter, the evidence chain and the alignment
 * panel. That is the design brief's rule made literal — every claim carries its
 * receipt, and receipts never interrupt the read.
 *
 * Both voices go through `ProseBlock`, so neither can emit raw HTML.
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
      ) : section.narrated ? (
        <>
          <ProseBlock paragraphs={section.paragraphs} className="mt-3 space-y-4" />
          <ul className="mt-5 space-y-4">
            {section.items.map((item) => (
              <li key={item.stableId}>
                <ClaimReceipts item={item} />
              </li>
            ))}
          </ul>
        </>
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
 * The elapsed-fact sigil: a mono day counter in a 1px-bordered pill.
 *
 * Shared by both voices so "day 6" is one object with one spelling, rather than a
 * span that drifted between two branches of the same component.
 */
function DayPill({ ageDays }: { readonly ageDays: number }) {
  if (ageDays <= 0) return null;

  return (
    <span className="ml-2 inline-flex items-baseline rounded-[4px] border border-rule-strong px-1.5 py-px font-mono text-[11px] not-italic tabular-nums text-ink-muted">
      day {ageDays}
    </span>
  );
}

/**
 * One claim's receipts, with no sentence of its own.
 *
 * Used under narrated prose. It carries no prose because the narration above it
 * already said the thing; repeating a templated sentence beneath a narrated one
 * would print every fact twice in two different voices. What it does carry is
 * everything a reader needs to *check* the claim, and the accessible name keeps the
 * row identifiable to a screen reader, which cannot see that the paragraph above
 * mentioned this ticket.
 */
function ClaimReceipts({ item }: { readonly item: ClaimView }) {
  return (
    <article aria-label={item.headline} className="border-l border-rule pl-4">
      {item.alignment?.question !== null && item.alignment?.question !== undefined && (
        <p className="alignment-question">{item.alignment.question}</p>
      )}

      <p className="flex flex-wrap items-baseline gap-x-1 text-[13px] text-ink-faint">
        <span className="sr-only">{item.headline}</span>
        <EvidenceMarkers evidence={item.evidence} />
        <DayPill ageDays={item.ageDays} />
      </p>

      {item.ladder !== null && <CompletionLadder ladder={item.ladder} />}
      <EvidenceChain evidence={item.evidence} />
      {item.alignment !== null && <AlignmentEvidence alignment={item.alignment} />}
    </article>
  );
}

/**
 * One claim in the templated voice: its sentences, its sigil, its notches and its
 * evidence.
 *
 * The day counter is a pill rather than a badge saying NEW, and the change since
 * yesterday is a run-in italic clause, because "this is day 6 of the same blocker"
 * is a fact a manager can act on and "NEW" is decoration.
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
        <DayPill ageDays={item.ageDays} />
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
