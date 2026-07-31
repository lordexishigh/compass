/**
 * @compass/delivery — the manager's own channels.
 *
 * Layer position: above `@compass/renderers`, below the worker and the web app. It holds the
 * email and Slack *channels* and the two transports that put them on a wire; it holds no
 * database access and no clock, so both channels are pure functions of a rendered report and
 * every scheduling decision takes `now` as a parameter.
 *
 * One rule runs through all of it: **the report arrives in full, inline, in the fixed order.**
 * Not a link, not a summary, not the first three sections with a "read more". A daily that
 * costs a context switch to read is not a daily, which is why `spine.ts` refuses to render a
 * report that is missing a section and why `slack.ts` splits a long section across blocks
 * rather than trimming it.
 */
export { DELIVERED_SECTION_KEYS, DeliverySpineError, orderedSections } from './spine.js';

export {
  emailSubject,
  listUnsubscribeHeaders,
  renderEmail,
  safeHeaderValue,
  type EmailRenderOptions,
  type RenderedEmail,
} from './email.js';

export {
  SLACK_BLOCK_TEXT_LIMIT,
  SLACK_MESSAGE_BLOCK_LIMIT,
  renderSlackBlocks,
  renderSlackMessages,
  slackTextChunks,
  type SlackBlock,
  type SlackMessage,
  type SlackRenderOptions,
} from './slack.js';

export {
  SHARE_EXPIRY_CHOICES,
  SHARE_LINK_STATUS,
  SHARE_TOKEN_BYTES,
  SHARE_TOKEN_LENGTH,
  hashShareToken,
  ipPrefixOf,
  isShareExpiryChoice,
  mintShareToken,
  shareLinkVerdict,
  shareTokenMatches,
  type MintedShareToken,
  type ShareExpiryChoice,
  type ShareLinkState,
  type ShareLinkVerdict,
} from './share-token.js';

export {
  InvalidScheduleError,
  assertSchedulable,
  defaultScopeFor,
  dueAtOn,
  dueDeliveries,
  scopesFor,
  shiftCivilDate,
  type DeliveryChannel,
  type DeliveryScope,
  type DueDelivery,
  type SubscriptionSchedule,
} from './schedule.js';

export {
  RESEND_API_KEY_ENV_VAR,
  RESEND_FROM_ENV_VAR,
  ResendEmailTransport,
  SLACK_BOT_TOKEN_ENV_VAR,
  SlackApiTransport,
  type DeliveryOutcome,
  type DeliveryOutcomeStatus,
  type EmailMessage,
  type EmailTransport,
  type SlackTarget,
  type SlackTransport,
} from './transport.js';
