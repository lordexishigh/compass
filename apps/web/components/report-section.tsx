import type { ClaimView, SectionView } from '../lib/view-model';

import { AlignmentEvidence } from './alignment-evidence';
import { CompletionLadder } from './completion-ladder';
import { EvidenceChain, EvidenceMarkers } from './evidence-markers';
import { FeedbackActions } from './feedback-actions';
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
              // The anchor the merged report links down to. `item-<stableId>` rather than the bare id,
              // because a stable id begins `v1:` and a fragment must be a valid identifier — and because
              // prefixing it says what kind of thing the anchor names.
              <li key={item.stableId} id={`item-${item.stableId}`} className="scroll-mt-24">
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
              // The anchor the merged report links down to. `item-<stableId>` rather than the bare id,
              // because a stable id begins `v1:` and a fragment must be a valid identifier — and because
              // prefixing it says what kind of thing the anchor names.
              <li key={item.stableId} id={`item-${item.stableId}`} className="scroll-mt-24">
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
 *
 * ## Which age it prints, and only which
 *
 * `seenDays` — the item's own age, counted from the first report that carried this id. "day 6" next
 * to a blocker therefore means "this is the sixth morning I have told you about this", which is a
 * fact about the report a manager can act on.
 *
 * It does **not** fall back to `ageDays`. The two are deliberately different facts everywhere else
 * in the codebase — `ageDays` is the condition's age from the tracker's own history, which is why a
 * blocker can arrive at "day 6" on the first morning Compass ever mentions it — and printing one
 * under a label defined as the other is the kind of quiet substitution that makes a manager distrust
 * every number on the page. On a first sighting there is no pill, which is correct: nothing has
 * recurred yet, and the condition's age is already stated in the prose beside it.
 */
function DayPill({ item }: { readonly item: ClaimView }) {
  const days = item.seenDays;
  if (days <= 0) return null;

  return (
    <span className="ml-2 inline-flex items-baseline rounded-[4px] border border-rule-strong px-1.5 py-px font-mono text-[11px] not-italic tabular-nums text-ink-muted">
      day {days}
    </span>
  );
}

/**
 * The run-in italic clause: what changed about this item since the previous report.
 *
 * "—— reviewer added, age unchanged", set as a serif italic clause rather than a badge saying
 * WORSENED, because the brief is explicit that change is *stated* and never colour-coded or
 * pill-shaped.
 *
 * It exists as its own component because the two voices need it in different places and for
 * different reasons. In the templated voice the renderer has already written the clause into the
 * claim's own sentences, so printing it again here would say one thing twice. Under **narrated**
 * prose there are no per-claim sentences to have carried it, and without this the only change signal
 * on a worsened item would be the report-level line at the top of the page — which is a fact about
 * the morning, not about this blocker.
 */
function ChangeClause({ clause }: { readonly clause: string | null }) {
  if (clause === null || clause.length === 0) return null;

  return (
    <p className="mt-1 font-serif text-[15px] italic leading-snug text-ink-muted">
      <span aria-hidden="true">—— </span>
      {clause}
    </p>
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
 *
 * The one sentence it does carry is the change clause. A model is free to reorder and merge items,
 * so it cannot be relied on to have said what moved about *this* one — and "what moved" is the whole
 * reason the page is worth re-reading rather than skimming.
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
        <DayPill item={item} />
      </p>

      {/* Suppressed once the manager's own verdict is on the item: `FeedbackActions` prints that
          instead, and their decision outranks Compass's arithmetic about what moved. */}
      {item.feedback === null && <ChangeClause clause={item.changeClause} />}

      {item.ladder !== null && <CompletionLadder ladder={item.ladder} />}
      <EvidenceChain evidence={item.evidence} />
      {item.alignment !== null && <AlignmentEvidence alignment={item.alignment} />}
      <FeedbackActions
        stableId={item.stableId}
        headline={item.headline}
        offers={item.feedbackOffers}
        existing={item.feedback}
      />
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
        <DayPill item={item} />
      </p>

      {item.alignment?.question !== null && item.alignment?.question !== undefined && (
        <p className="alignment-question">{item.alignment.question}</p>
      )}

      {item.ladder !== null && <CompletionLadder ladder={item.ladder} />}
      <EvidenceChain evidence={item.evidence} />
      {item.alignment !== null && <AlignmentEvidence alignment={item.alignment} />}
      <FeedbackActions
        stableId={item.stableId}
        headline={item.headline}
        offers={item.feedbackOffers}
        existing={item.feedback}
      />
    </article>
  );
}
