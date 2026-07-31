import type { LadderView } from '../lib/view-model';

/**
 * The five-notch completion meter.
 *
 * Five 3px×10px marks — hairline zinc-300 for uncrossed, solid emerald-600 for
 * crossed — followed by the rung label in mono. This is the most recognisable
 * object in the product, and it exists because "done" is not one bit: a ticket
 * marked done with no merge behind it and a ticket that shipped are different
 * facts, and the notches show the difference at a glance.
 *
 * R5 is the honest part. With no CI/CD connector there is no deploy signal, so
 * the fifth notch is hollow and the literal words *no deploy signal available*
 * are printed rather than the rung being quietly dropped or, far worse, inferred
 * from the merge.
 *
 * Marks are `aria-hidden`; the sentence beside them is the accessible content,
 * because a screen reader user needs "reached R2 merged", not five divs.
 */
export function CompletionLadder({ ladder }: { readonly ladder: LadderView }) {
  const unreachable = ladder.notches.filter((notch) => !notch.reachable);

  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
      <span aria-hidden="true" className="flex items-center gap-1">
        {ladder.notches.map((notch) => (
          <span
            key={notch.rung}
            title={`${notch.rung} ${notch.label}`}
            className={[
              'inline-block h-[10px] w-[3px] rounded-[1px]',
              !notch.reachable
                ? 'border border-rule-strong bg-transparent'
                : notch.crossed
                  ? 'bg-verified'
                  : 'bg-rule-strong',
            ].join(' ')}
          />
        ))}
      </span>

      <span className="data-token text-ink-muted">
        {ladder.highestCrossed === 'R0' || ladder.highestCrossedLabel === null
          ? 'no rung crossed'
          : `${ladder.highestCrossed} ${ladder.highestCrossedLabel}`}
      </span>

      {unreachable.map((notch) => (
        <span key={`unreachable-${notch.rung}`} className="stated-absence text-[13px]">
          {notch.statement ?? 'no deploy signal available'}
        </span>
      ))}
    </p>
  );
}
