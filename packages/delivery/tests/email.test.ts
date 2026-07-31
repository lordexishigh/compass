import { SECTIONS, SECTION_ORDER } from '@compass/analysis';
import { DeliverySpineError, emailSubject, renderEmail, safeHeaderValue } from '@compass/delivery';
import { describe, expect, it } from 'vitest';

import { HOSTILE_CLAIM, HOSTILE_TITLE, renderedReport, section } from './helpers/report.js';

/**
 * The email channel.
 *
 * Two acceptance criteria dominate this file and both are about what the email is *not*:
 *
 *  1. **It is not a stub.** All six sections, in full, in the body. A "click here to view your
 *     report" email is a notification about a daily rather than a daily, and it dies in the
 *     first week because reading it costs a context switch.
 *  2. **It is not an injection vector.** A ticket can be titled `<script>…</script>` followed by
 *     a CRLF and a `Bcc:` header, and that title reaches a headline, the headline reaches the
 *     prose, and the prose reaches this renderer. It must come out as the literal characters a
 *     manager should see, with no executable markup and no extra header.
 */

const OPTIONS = {
  reportUrl: 'https://compass.acme.example/reports/2026-08-03',
  unsubscribeUrl: 'https://compass.acme.example/api/delivery/unsubscribe?token=abc123',
  recipient: 'priya@acme.example',
} as const;

describe('the email body carries the whole report', () => {
  const email = renderEmail(renderedReport(), OPTIONS);

  it('contains all six sections, in the fixed order, in both parts', () => {
    for (const definition of SECTIONS) {
      expect(email.html, `${definition.key} missing from the HTML part`).toContain(definition.title);
      expect(email.text, `${definition.key} missing from the text part`).toContain(
        definition.title.toUpperCase(),
      );
    }

    // Order, not just presence: the Six Spine is the same in every channel forever, so a
    // manager can read it like a familiar newspaper.
    const positions = SECTIONS.map((definition) => email.html.indexOf(definition.title));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(positions.every((position) => position >= 0)).toBe(true);
  });

  it('numbers them 01–06 so the geography survives the channel', () => {
    for (const definition of SECTIONS) {
      expect(email.html).toContain(definition.numeral);
      expect(email.text).toContain(`${definition.numeral} ${definition.title.toUpperCase()}`);
    }
  });

  it('has no click-to-view stub standing in for the content', () => {
    // The exact phrasings a stub email uses. The footer link is allowed to exist — it goes to
    // the evidence gutter, which email cannot carry — but it must not be the body.
    for (const stub of [
      /click here to view/i,
      /view (the )?(full )?report online/i,
      /read (the )?(full )?report (online|in your browser)/i,
      /your report is ready/i,
      /see the full report/i,
    ]) {
      expect(email.html, `stub phrasing ${stub} in the HTML part`).not.toMatch(stub);
      expect(email.text, `stub phrasing ${stub} in the text part`).not.toMatch(stub);
    }
  });

  it('states that the report is already above, next to the one link it does carry', () => {
    // The link's job is stated so a reader knows it is not where the content is.
    expect(email.text).toContain('The full report is above.');
    expect(email.html).toContain('The full report is above.');
    expect(email.html).toContain(OPTIONS.reportUrl);
  });

  it('truncates nothing: every claim of every section is present', () => {
    const report = renderedReport({
      sections: SECTION_ORDER.map((key, position) =>
        section(key, position + 1, {
          claims: Array.from({ length: 12 }, (_, index) => ({
            stableId: `${key}:${index}`,
            prose: `Claim ${index} about ${key} carries a distinctive marker ${key}-${index}-end.`,
          })),
        }),
      ),
    });

    const rendered = renderEmail(report, OPTIONS);

    for (const key of SECTION_ORDER) {
      for (let index = 0; index < 12; index += 1) {
        expect(rendered.text, `${key}-${index} missing from the text part`).toContain(`${key}-${index}-end`);
        expect(rendered.html, `${key}-${index} missing from the HTML part`).toContain(`${key}-${index}-end`);
      }
    }
  });

  it('emits an empty section as its stated absence rather than skipping it', () => {
    // A silently omitted section reads as one that was forgotten. The statement comes from the
    // rendered prose, so the channel's job is simply never to skip.
    const report = renderedReport({
      sections: SECTION_ORDER.map((key, position) =>
        section(key, position + 1, {
          claims: [],
          lead: SECTIONS[position]?.emptyStatement ?? 'Nothing to report.',
        }),
      ),
    });

    const rendered = renderEmail(report, OPTIONS);

    for (const definition of SECTIONS) {
      expect(rendered.html).toContain(definition.title);
      expect(rendered.text).toContain(definition.emptyStatement);
    }
  });

  it('refuses a report that is missing a section rather than sending a plausible one', () => {
    const short = renderedReport({
      sections: SECTION_ORDER.slice(0, 5).map((key, position) => section(key, position + 1)),
    });

    expect(() => renderEmail(short, OPTIONS)).toThrow(DeliverySpineError);
  });
});

describe('a hostile ticket title in an email', () => {
  const report = renderedReport({
    sections: SECTION_ORDER.map((key, position) =>
      section(key, position + 1, {
        claims: [{ stableId: `${key}:1`, prose: HOSTILE_CLAIM }],
      }),
    ),
    masthead: `Compass — platform — 2026-08-03 ${HOSTILE_TITLE}`,
  });

  const email = renderEmail(report, OPTIONS);

  it('emits the script tag as literal text, with no executable markup', () => {
    // Escaped, so the characters survive and the tag does not. "A ticket is *called* that" is a
    // fact the report has to be able to state.
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toMatch(/<script/i);
    expect(email.html).not.toContain('document.cookie</');

    // The text part keeps it verbatim, which is correct: there is no markup context to escape
    // into, and a manager should see what the ticket is called.
    expect(email.text).toContain('<script>');
  });

  it('injects no header, because every header value has its newlines folded out', () => {
    // The subject is built from the masthead, which carries the payload.
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).toContain('Bcc: attacker@evil.test');
    expect(email.subject.split('\n')).toHaveLength(1);

    for (const [name, value] of Object.entries(email.headers)) {
      expect(value, `${name} carries a newline`).not.toMatch(/[\r\n]/);
    }
  });

  it('keeps the payload out of the header set itself', () => {
    // The proof that no *new* header appeared: the set is exactly the two RFC 8058 ones.
    expect(Object.keys(email.headers).sort()).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
  });

  it('folds newlines in any header value, not only the subject', () => {
    expect(safeHeaderValue('fine\r\nBcc: attacker@evil.test')).toBe('fine Bcc: attacker@evil.test');
    expect(safeHeaderValue('a\nb\r\nc')).not.toMatch(/[\r\n]/);
  });

  it('does not let the payload become an attribute or a tag in the footer either', () => {
    const withHostileUrl = renderEmail(renderedReport(), {
      ...OPTIONS,
      recipient: '"><script>alert(1)</script>',
    });

    expect(withHostileUrl.html).not.toMatch(/<script/i);
    expect(withHostileUrl.html).toContain('&lt;script&gt;');
  });
});

describe('RFC 8058 one-click unsubscribe', () => {
  const email = renderEmail(renderedReport(), OPTIONS);

  it('sends both headers, because either alone is useless', () => {
    // The URL alone gets the old mailto behaviour; the Post header alone means nothing. The
    // pair is what makes a client show its own one-click button.
    expect(email.headers['List-Unsubscribe']).toBe(`<${OPTIONS.unsubscribeUrl}>`);
    expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('wraps the URL in angle brackets, as the RFC requires', () => {
    expect(email.headers['List-Unsubscribe']).toMatch(/^<https:\/\/.+>$/);
  });

  it('also offers the link in the body, so it is findable without client support', () => {
    // An unsubscribe a reader cannot find becomes a spam report, which costs the sending domain
    // far more than the unsubscribe would have.
    expect(email.html).toContain(OPTIONS.unsubscribeUrl);
    expect(email.text).toContain(OPTIONS.unsubscribeUrl);
  });
});

describe('the subject line', () => {
  it('is the masthead, so the inbox shows team and date', () => {
    expect(emailSubject(renderedReport())).toBe('Compass — platform — 2026-08-03');
  });
});
