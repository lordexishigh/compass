/**
 * A failure, stated in the product's own voice.
 *
 * The design brief's honest-degradation rule applies to errors as much as to thin data:
 * *"Low confidence, thin data, missing deploy signal and disconnected sources are typeset
 * as first-class stated facts in the prose voice, never hidden, never a grey skeleton
 * box."* An unreachable database on `/account` is the same kind of fact, so it gets the
 * same treatment — a sentence in the reading column with a severe hairline beside it,
 * never a stack trace and never an illustrated error page.
 *
 * No colour. Compass never colour-codes bad news, so severity is carried by the rule
 * weight (`--rule-severe`, zinc-900) exactly as it is in the report's own sections.
 *
 * A Server Component, so a page can render one without a client island — which matters,
 * because the condition it describes is often "JavaScript aside, the server could not
 * answer".
 */
export function StatedFailure({
  heading,
  detail,
  children,
}: {
  readonly heading?: string;
  readonly detail: string;
  /** Where to go instead. Always offered: a dead end is not an answer. */
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="mt-8">
      {heading !== undefined && <p className="section-label">{heading}</p>}
      <p role="alert" className="prose-narration mt-2 border-l-2 border-rule-severe pl-3">
        {detail}
      </p>
      {children !== undefined && <p className="mt-5 flex flex-wrap gap-x-5 text-[13px]">{children}</p>}
    </div>
  );
}
