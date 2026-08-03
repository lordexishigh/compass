import type { SlackMessage } from './slack.js';

/**
 * The notice Compass posts in a channel it has been told to read.
 *
 * ## Why the bot announces itself
 *
 * "It reads as surveillance" is the listed reason managers abandon a product like this,
 * and the surveillance feeling does not come from the reading — it comes from the reading
 * being invisible. A team that can see a message in their own channel saying what Compass
 * does with it has been told; a team that has to be shown a settings page by their manager
 * has been informed *by their manager*, which is a different and worse thing.
 *
 * So the notice is posted in the channel, by the bot, at the moment ingestion is turned
 * on, and it says four things: that Compass reads this channel, who turned it on, how long
 * the messages are kept, and where to see what is held. Nothing about it is a
 * confirmation prompt — the manager has the authority to enable it and the team has the
 * right to know, and those are not the same question.
 *
 * ## Why it is rendered here and not in the worker
 *
 * `@compass/delivery` owns everything Compass says on a channel a person reads. Composing
 * this in the worker would put product wording in a job handler, where no renderer test
 * would ever see it.
 */

export interface ChannelNoticeInput {
  readonly conversationName: string;
  /** Who turned it on. Null when the row predates actor recording. */
  readonly enabledByName: string | null;
  /** The raw-event retention window, in days. */
  readonly retentionDays: number;
  /** Absolute URL of the page that lists what Compass holds about the reader. */
  readonly transparencyUrl: string;
  /** Absolute URL of the settings page listing every ingested channel. */
  readonly settingsUrl: string;
}

/** The one-line summary a Slack client shows in a notification. */
export const channelNoticeText = (input: ChannelNoticeInput): string =>
  `Compass now reads #${input.conversationName} to build the team's daily report.`;

/**
 * The notice, as blocks.
 *
 * Deliberately five short paragraphs and no buttons. A notice with an action in it invites
 * somebody to click before reading, and there is no action here that a channel member is
 * entitled to take — turning ingestion off is the manager's decision, and pretending
 * otherwise with a disabled button would be worse than not offering one.
 */
export function renderChannelNotice(input: ChannelNoticeInput): SlackMessage {
  const who =
    input.enabledByName === null || input.enabledByName.trim().length === 0
      ? 'An owner or manager'
      : input.enabledByName;

  const paragraphs = [
    `*Compass reads this channel.* ${who} turned it on, so that the team's daily report can cite what was ` +
      'said here alongside the tickets, pull requests and releases it already reads.',
    `Messages posted here are kept for *${input.retentionDays} days* and then deleted. Compass never reads ` +
      'direct messages or private channels — not as a setting, but at all.',
    'Nothing said here is shown to a language model. Compass computes the report first and only asks a model ' +
      'to word the result, and message text is excluded from what the model is shown.',
    `You can see exactly what Compass holds about you, and every report line that names you, here: ` +
      `${input.transparencyUrl}`,
    `Every channel Compass reads is listed here, with the date each was enabled: ${input.settingsUrl}`,
  ];

  return {
    text: channelNoticeText(input),
    blocks: paragraphs.map((text) => ({
      type: 'section',
      text: { type: 'mrkdwn', text },
    })),
  };
}
