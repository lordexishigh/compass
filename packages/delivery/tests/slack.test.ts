import { SECTIONS, SECTION_ORDER } from '@compass/analysis';
import {
  DeliverySpineError,
  SLACK_BLOCK_TEXT_LIMIT,
  SLACK_MESSAGE_BLOCK_LIMIT,
  renderSlackBlocks,
  renderSlackMessages,
  slackTextChunks,
  type SlackBlock,
} from '@compass/delivery';
import { describe, expect, it } from 'vitest';

import { HOSTILE_CLAIM, renderedReport, section } from './helpers/report.js';

/**
 * Slack Block Kit.
 *
 * Slack's limits collide head-on with "no truncation", and this file is where that collision is
 * held to the right resolution. A section block caps at 3000 characters and a message at 50
 * blocks; the answer to both is to *split*, never to trim. The assertions therefore reassemble
 * the emitted text and compare it to the source, because a test that only checked "every block
 * is under 3000" would pass for an implementation that dropped the remainder.
 */

const OPTIONS = { reportUrl: 'https://compass.acme.example/reports/2026-08-03' } as const;

const textOf = (blocks: readonly SlackBlock[]): string =>
  blocks
    .filter((block) => block.type === 'section')
    .map((block) => block.text?.text ?? '')
    .join('\n\n');

describe('the Slack message carries the whole report', () => {
  const blocks = renderSlackBlocks(renderedReport(), OPTIONS);

  it('contains all six sections in the fixed order', () => {
    const headers = blocks
      .filter((block) => block.type === 'header')
      .map((block) => block.text?.text ?? '');

    // The masthead is the first header; the six section headers follow in order.
    expect(headers[0]).toContain('Compass');
    for (const [index, definition] of SECTIONS.entries()) {
      expect(headers[index + 1]).toBe(`${definition.numeral} ${definition.title}`);
    }
  });

  it('has no click-to-view stub and no image block', () => {
    for (const stub of [/click here/i, /view (the )?(full )?report/i, /your report is ready/i]) {
      expect(textOf(blocks)).not.toMatch(stub);
    }
    // No chart, ever: there is no image block in the message at all.
    expect(blocks.some((block) => block.type === 'image')).toBe(false);
  });

  it('states that the report is above, next to the one link it carries', () => {
    const contexts = blocks
      .filter((block) => block.type === 'context')
      .flatMap((block) => (block.elements ?? []) as { readonly text?: string }[])
      .map((element) => element.text ?? '');

    expect(contexts.join(' ')).toContain('The full report is above.');
    expect(contexts.join(' ')).toContain(OPTIONS.reportUrl);
  });

  it('refuses a report missing a section rather than posting a plausible one', () => {
    const short = renderedReport({
      sections: SECTION_ORDER.slice(0, 5).map((key, position) => section(key, position + 1)),
    });
    expect(() => renderSlackBlocks(short, OPTIONS)).toThrow(DeliverySpineError);
  });
});

describe('a section longer than Slack will accept in one block', () => {
  // ~9k characters in one section: three blocks' worth, so the split is exercised rather than
  // just being possible.
  const longClaims = Array.from({ length: 60 }, (_, index) => ({
    stableId: `blockers:${index}`,
    prose: `Claim ${index} about a stalled ticket, with a distinctive marker marker-${index}-end, padded out to make the section long enough that Slack would refuse it in a single block.`,
  }));

  const report = renderedReport({
    sections: SECTION_ORDER.map((key, position) =>
      key === 'blockers' ? section(key, position + 1, { claims: longClaims }) : section(key, position + 1),
    ),
  });

  const blocks = renderSlackBlocks(report, OPTIONS);

  it('splits it across blocks instead of trimming it', () => {
    const bodies = blocks.filter((block) => block.type === 'section');
    expect(bodies.length, 'a long section needs more than one block').toBeGreaterThan(SECTION_ORDER.length);

    for (const block of bodies) {
      expect((block.text?.text ?? '').length).toBeLessThanOrEqual(SLACK_BLOCK_TEXT_LIMIT);
    }
  });

  it('loses nothing: every claim survives the split', () => {
    const reassembled = textOf(blocks);
    for (let index = 0; index < longClaims.length; index += 1) {
      expect(reassembled, `marker-${index} was dropped`).toContain(`marker-${index}-end`);
    }
  });

  it('never splits mid-word', () => {
    // A seam inside `marker-37-end` would satisfy "nothing dropped" while still corrupting the
    // identifier a manager searches their board for.
    for (const block of blocks.filter((entry) => entry.type === 'section')) {
      const text = block.text?.text ?? '';
      expect(text).toBe(text.trim());
      expect(text).not.toMatch(/marker-\d+-$/);
      expect(text).not.toMatch(/^-?end\b/);
    }
  });
});

describe('slackTextChunks', () => {
  it('returns the text unchanged when it already fits', () => {
    expect(slackTextChunks('short enough')).toEqual(['short enough']);
    expect(slackTextChunks('')).toEqual([]);
  });

  it('prefers a paragraph boundary as the seam', () => {
    const first = 'a'.repeat(40);
    const second = 'b'.repeat(40);
    expect(slackTextChunks(`${first}\n\n${second}`, 50)).toEqual([first, second]);
  });

  it('falls back to a word boundary when one paragraph is itself too long', () => {
    const chunks = slackTextChunks('alpha beta gamma delta epsilon', 12);

    expect(chunks.join(' ')).toBe('alpha beta gamma delta epsilon');
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
    // No chunk starts or ends mid-word.
    expect(chunks.every((chunk) => chunk === chunk.trim())).toBe(true);
  });

  it('hard-cuts only a single word that cannot fit at all', () => {
    // A 40-character token with a 10-character limit: every option loses something, and
    // dropping the tail would lose more than cutting it.
    const token = 'x'.repeat(40);
    const chunks = slackTextChunks(token, 10);

    expect(chunks.join('')).toBe(token);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
  });
});

describe('a report needing more blocks than one message allows', () => {
  // Enough sections' worth of content to push past 50 blocks.
  const hugeClaims = Array.from({ length: 40 }, (_, index) => ({
    stableId: `risks:${index}`,
    prose: `${'y'.repeat(2900)} tail-${index}-end`,
  }));

  const report = renderedReport({
    sections: SECTION_ORDER.map((key, position) =>
      key === 'risks' ? section(key, position + 1, { claims: hugeClaims }) : section(key, position + 1),
    ),
  });

  const messages = renderSlackMessages(report, OPTIONS);

  it('becomes several messages rather than a truncated one', () => {
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.blocks.length).toBeLessThanOrEqual(SLACK_MESSAGE_BLOCK_LIMIT);
    }
  });

  it('keeps every block, in order, across the messages', () => {
    const flat = renderSlackBlocks(report, OPTIONS);
    const rejoined = messages.flatMap((message) => message.blocks);

    expect(rejoined).toHaveLength(flat.length);
    expect(rejoined).toEqual(flat);
  });

  it('names the part in the fallback line, so a continuation is not read as a duplicate', () => {
    expect(messages[0]?.text).toContain(`1 of ${messages.length}`);
    expect(messages.at(-1)?.text).toContain(`${messages.length} of ${messages.length}`);
  });

  it('loses none of the content across the message boundary', () => {
    const reassembled = textOf(messages.flatMap((message) => message.blocks));
    for (let index = 0; index < hugeClaims.length; index += 1) {
      expect(reassembled, `tail-${index} was dropped at a message boundary`).toContain(`tail-${index}-end`);
    }
  });

  it('sends a single message when the report fits', () => {
    const single = renderSlackMessages(renderedReport(), OPTIONS);
    expect(single).toHaveLength(1);
    expect(single[0]?.text).not.toContain(' of ');
  });
});

describe('a hostile ticket title in Slack', () => {
  const report = renderedReport({
    sections: SECTION_ORDER.map((key, position) =>
      section(key, position + 1, { claims: [{ stableId: `${key}:1`, prose: HOSTILE_CLAIM }] }),
    ),
  });

  const blocks = renderSlackBlocks(report, OPTIONS);

  it('emits it as literal text through the sanitizer', () => {
    const text = textOf(blocks);

    // Literal characters, because "a ticket is called that" is a fact the report must state.
    expect(text).toContain('<script>');
    // And the markdown markers the prose used are gone — it went through `renderProseText`,
    // so nothing a ticket is titled can arrive as Slack markup.
    expect(text).not.toContain('`DEV-9`');
    expect(text).toContain('DEV-9');
  });

  it('puts headings in plain_text so a title cannot become mrkdwn', () => {
    for (const block of blocks.filter((entry) => entry.type === 'header')) {
      expect(block.text?.type).toBe('plain_text');
    }
  });

  it('keeps every block within Slack header and text limits', () => {
    for (const block of blocks) {
      if (block.type === 'header') expect((block.text?.text ?? '').length).toBeLessThanOrEqual(150);
      if (block.type === 'section') {
        expect((block.text?.text ?? '').length).toBeLessThanOrEqual(SLACK_BLOCK_TEXT_LIMIT);
      }
    }
  });
});
