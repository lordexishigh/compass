import type { ProseInline, ProseParagraph } from '@compass/renderers';

/**
 * Prose, rendered from allowlisted tokens.
 *
 * There is no `dangerouslySetInnerHTML` anywhere in Compass, and this component is
 * why there does not need to be. The view model has already parsed the prose into a
 * closed set of four token types, and this maps each one onto a React element.
 *
 * The consequence is that a ticket titled `<script>…</script>` cannot execute here
 * *by construction* rather than by escaping: React renders a string child as a text
 * node, so the characters `<`, `s`, `c`… are appended as text and there is no code
 * path that could have parsed them as a tag. Nothing is stripped either, so the
 * report can still tell a manager what the ticket is actually called — which it has
 * to be able to do, because that is a fact about their board.
 *
 * The tokens come from `@compass/renderers`, shared with the static HTML report and
 * (later) the email body, so a payload that renders as text here cannot render as
 * markup there.
 */
function Inline({ inline }: { readonly inline: ProseInline }) {
  switch (inline.type) {
    case 'strong':
      // Bold serif, adjacent to a specific object and action — the design brief's
      // rule for a person's name.
      return <strong className="font-semibold text-ink-strong">{inline.text}</strong>;
    case 'emphasis':
      // The run-in italic clause: "reviewer added, age unchanged".
      return <em className="italic text-ink-muted">{inline.text}</em>;
    case 'code':
      return <code className="data-token">{inline.text}</code>;
    case 'text':
      return <>{inline.text}</>;
  }
}

export function ProseBlock({
  paragraphs,
  className,
}: {
  readonly paragraphs: readonly ProseParagraph[];
  readonly className?: string;
}) {
  if (paragraphs.length === 0) return null;

  return (
    <div className={className ?? 'space-y-4'}>
      {paragraphs.map((paragraph, index) => (
        // Index keys are correct here and only here: paragraphs have no identity of
        // their own, they are positions in one immutable string, and the whole block
        // is replaced together whenever the prose changes.
        <p key={index} className="prose-narration">
          {paragraph.inlines.map((inline, inlineIndex) => (
            <Inline key={inlineIndex} inline={inline} />
          ))}
        </p>
      ))}
    </div>
  );
}
