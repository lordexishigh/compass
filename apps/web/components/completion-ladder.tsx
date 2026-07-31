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

  /**
   * The suffix with its leading rung label removed.
   *
   * `merged, not yet released` becomes `not yet released`, because the mono token
   * beside it already reads `R2 merged` and printing the word twice on one line
   * makes the meter look like a template. When the suffix carries no comma there is
   * nothing left to add, and this is null.
   */
  const remainder = (() => {
    const suffix = ladder.rungSuffix;
    if (suffix === null) return null;
    const comma = suffix.indexOf(', ');
    if (comma === -1) return null;
    return suffix.slice(comma + 2);
  })();

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

      {/*
        The half of the completion that has *not* happened, as a run-in serif italic
        clause: `not yet released`. The mono label above says how far the work got;
        this says where it stopped, which is the part a manager can act on. Split off
        the suffix so the sentence is not printed twice — the suffix begins with the
        same rung label the mono token already carries.
      */}
      {remainder !== null && <span className="font-serif text-[13px] italic text-ink-muted">{remainder}</span>}

      {unreachable.map((notch) => (
        <span key={`unreachable-${notch.rung}`} className="stated-absence text-[13px]">
          {notch.statement ?? 'no deploy signal available'}
        </span>
      ))}
    </p>
  );
}
