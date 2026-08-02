import { renderProseText, type RenderedReport } from '@compass/renderers';

import { slackActionId } from './slack-actions.js';
import { orderedSections } from './spine.js';

/**
 * The Slack channel: the whole report inline, in Block Kit.
 *
 * Two of Slack's limits collide head-on with "no truncation", and how that collision is
 * resolved is the whole design of this file:
 *
 *  - **A section block's text caps at 3000 characters.** So a long section is *split across
 *    several blocks* rather than trimmed. `slackTextChunks` splits on paragraph boundaries
 *    first and on word boundaries only if a single paragraph is itself over the cap, so a split
 *    never lands mid-word and never mid-sentence unless a sentence is 3000 characters long.
 *  - **A message caps at 50 blocks.** So a report that needs more becomes *several messages*,
 *    posted in order, rather than a truncated one. `renderSlackMessages` returns a list.
 *
 * The reassembled text of every block equals the source prose exactly, and
 * `tests/slack.test.ts` asserts that rather than asserting a length — a test that checked only
 * "under 3000" would pass for an implementation that dropped the remainder.
 *
 * ## No mrkdwn, no chart, no stub
 *
 * Text goes in as `plain_text` for headers and `mrkdwn` for bodies, but every body string comes
 * from `renderProseText`, which has already reduced the prose to literal characters through the
 * shared allowlist. Slack's own mrkdwn is therefore the only markup in the message and nothing
 * a ticket is titled can become markup. There is no image block, so there is no chart, and
 * there is no "view report" button standing in for the content.
 */

/** Slack's documented per-block text cap. */
export const SLACK_BLOCK_TEXT_LIMIT = 3000;

/** Slack's documented per-message block cap. */
export const SLACK_MESSAGE_BLOCK_LIMIT = 50;

export interface SlackBlock {
  readonly type: string;
  readonly text?: { readonly type: string; readonly text: string };
  readonly elements?: readonly unknown[];
  /** Present on an actions block: `compass_item:<stableId>`. */
  readonly block_id?: string;
}

/**
 * One item's feedback buttons, as the caller decided them.
 *
 * The renderer is handed the offers rather than deriving them, because *which* actions an item
 * offers is a product rule that lives in `@compass/analysis` (`feedbackOffersFor`) and must be the
 * same in the web view, the email and here. A renderer that decided for itself would be a fourth
 * opinion, and the first one to drift would leave a manager able to reject a step in Slack that the
 * page does not let them reject.
 */
export interface SlackItemActions {
  readonly itemStableId: string;
  /** The claim these buttons belong to, so the block reads as being about something. */
  readonly headline: string;
  readonly actions: readonly { readonly action: string; readonly label: string }[];
}

export interface SlackRenderOptions {
  readonly reportUrl: string;
  /**
   * Per-item buttons, in report order.
   *
   * Rendered immediately beneath the section they belong to rather than collected at the end of
   * the message: a button four screens away from the claim it acts on is a button a manager will
   * not trust, and Slack gives no way to point one at a paragraph.
   */
  readonly itemActions?: readonly SlackItemActions[];
}

export interface SlackMessage {
  readonly blocks: readonly SlackBlock[];
  /** The notification line, for a client that cannot render blocks. */
  readonly text: string;
}

/**
 * Splits text into chunks no longer than `limit`, losing nothing.
 *
 * Paragraph boundaries first, because a paragraph break is where a reader expects a seam. Only
 * when a single paragraph exceeds the limit does it fall back to word boundaries, and only when
 * a single *word* does — a 3000-character SHA-like token — is a hard cut taken, because at that
 * point every option loses something and dropping the tail would lose more.
 */
export function slackTextChunks(text: string, limit: number = SLACK_BLOCK_TEXT_LIMIT): readonly string[] {
  if (text.length <= limit) return text.length === 0 ? [] : [text];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  const appendWithin = (piece: string, separator: string): void => {
    const candidate = current.length === 0 ? piece : `${current}${separator}${piece}`;
    if (candidate.length <= limit) {
      current = candidate;
      return;
    }
    flush();
    if (piece.length <= limit) {
      current = piece;
      return;
    }
    // A single piece over the limit: break it on words, then hard-cut a word that cannot fit.
    let rest = piece;
    while (rest.length > limit) {
      const window = rest.slice(0, limit + 1);
      const breakAt = window.lastIndexOf(' ');
      const cut = breakAt > 0 ? breakAt : limit;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(breakAt > 0 ? cut + 1 : cut);
    }
    current = rest;
  };

  for (const block of text.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    appendWithin(trimmed, '\n\n');
  }

  flush();
  return chunks;
}

const header = (text: string): SlackBlock => ({
  type: 'header',
  // `plain_text`, so a ticket title in a heading cannot become mrkdwn.
  text: { type: 'plain_text', text: text.slice(0, 150) },
});

const body = (text: string): SlackBlock => ({ type: 'section', text: { type: 'mrkdwn', text } });

const context = (text: string): SlackBlock => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text }],
});

/**
 * Every block for the report, in the fixed order, with nothing dropped.
 *
 * Returned as one flat list so a caller can assert against it; `renderSlackMessages` is what
 * splits it into postable messages.
 */
export function renderSlackBlocks(report: RenderedReport, options: SlackRenderOptions): readonly SlackBlock[] {
  const sections = orderedSections(report);
  const actionsByItem = new Map((options.itemActions ?? []).map((entry) => [entry.itemStableId, entry]));
  const blocks: SlackBlock[] = [header(report.masthead), context(report.freshness)];

  // The change line, directly under the freshness note and above the six sections — the same
  // position it holds in the email and on the page. "Nothing material changed since yesterday" is
  // the whole report on a quiet morning, and a reader who has that sentence in the first screenful
  // does not scroll six sections to discover it.
  if (report.changeLine.length > 0) blocks.push(context(renderProseText(report.changeLine)));

  for (const section of sections) {
    blocks.push({ type: 'divider' });
    // The numeral travels with the title, so the Six Spine's geography survives in Slack.
    blocks.push(header(`${section.numeral} ${section.title}`));

    for (const chunk of slackTextChunks(renderProseText(section.prose))) {
      blocks.push(body(chunk));
    }

    for (const claim of section.claims) {
      const entry = actionsByItem.get(claim.stableId);
      if (entry === undefined || entry.actions.length === 0) continue;
      // The headline in a context block above the buttons, so a row of verbs is never ambiguous
      // about which of four blockers it would act on.
      blocks.push(context(`*${renderProseText(entry.headline)}*`));
      blocks.push({
        type: 'actions',
        // `block_id` carries the item, so an interaction payload identifies its claim even if
        // Slack ever stopped echoing the button's own value.
        block_id: `compass_item:${claim.stableId}`,
        elements: entry.actions.map((action) => ({
          type: 'button',
          text: { type: 'plain_text', text: action.label },
          action_id: slackActionId(action.action),
          // The item id travels in `value`: `action_id` must be unique within a message, and a
          // report with two dismissible risks would collide on the first one otherwise.
          value: claim.stableId,
        })),
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push(
    context(
      `The full report is above. <${options.reportUrl}|Open it in Compass> to follow the evidence for any claim.`,
    ),
  );

  return blocks;
}

/**
 * The blocks split into messages that Slack will actually accept.
 *
 * A report needing 60 blocks becomes two messages rather than 50 blocks and a shrug. The split
 * is on the block list, so it never lands inside a block's text — the seam is always between
 * two blocks, and the sections stay in order across the messages.
 */
export function renderSlackMessages(
  report: RenderedReport,
  options: SlackRenderOptions,
): readonly SlackMessage[] {
  const blocks = renderSlackBlocks(report, options);
  const messages: SlackMessage[] = [];

  for (let index = 0; index < blocks.length; index += SLACK_MESSAGE_BLOCK_LIMIT) {
    const slice = blocks.slice(index, index + SLACK_MESSAGE_BLOCK_LIMIT);
    const part = messages.length + 1;
    const total = Math.ceil(blocks.length / SLACK_MESSAGE_BLOCK_LIMIT);
    messages.push({
      blocks: slice,
      // The fallback line names the part, so a continuation is not mistaken for a duplicate.
      text: total === 1 ? report.masthead : `${report.masthead} (${part} of ${total})`,
    });
  }

  return messages;
}
