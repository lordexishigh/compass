import type { EmptyStateCopy } from '../lib/empty-states';

/**
 * A list with nothing in it, designed.
 *
 * ## What this is not
 *
 * Not a card, not a panel, not a centred illustration with a button under it, and above all
 * not a grey skeleton box. Compass is a document: an empty list is a paragraph in the same
 * measure as every other paragraph, set with the same left hairline as a report item, with
 * the one action that would change it at the end. Read top to bottom it is indistinguishable
 * in weight from a list that has entries — which is the point, because a screen that
 * *shouts* when it is empty teaches the reader that empty is an error.
 *
 * ## The two voices
 *
 * `statement` is the stated absence, and it takes the `stated-absence` treatment — serif
 * italic zinc — because it is exactly the same kind of sentence as "no deploy signal
 * available" on a completion ladder. `explanation` is ordinary narration: what would be
 * here and what it would mean. Neither is red, amber or emerald. An empty list is not bad
 * news and Compass does not colour-code it.
 *
 * The one piece of colour is the action, which uses the standard primary control — the same
 * emerald fill as every other primary action in the product, so it reads as "the thing to do
 * here" rather than as an alert about the emptiness.
 *
 * `data-empty-state` carries the entry's id into the markup. That is what lets
 * `tests/empty-states.test.tsx` assert, over rendered output rather than over source, that
 * each list actually shows its own copy — a screen wired to the wrong registry entry looks
 * perfectly reasonable in review.
 */
export function EmptyState({ copy }: { readonly copy: EmptyStateCopy }) {
  return (
    <div
      data-empty-state={copy.id}
      data-empty-disposition={copy.disposition}
      className="mt-4 max-w-[38rem] border-l border-rule-strong pl-4"
    >
      <p className="stated-absence text-[17px] leading-relaxed">{copy.statement}</p>
      <p className="prose-narration mt-2 text-[15px] leading-relaxed text-ink-muted">{copy.explanation}</p>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
        <a href={copy.action.href} className="primary-action">
          {copy.action.label}
        </a>
        {copy.secondary?.map((action) => (
          <a key={action.href} href={action.href} className="tertiary-action">
            {action.label}
          </a>
        ))}
      </div>
    </div>
  );
}
