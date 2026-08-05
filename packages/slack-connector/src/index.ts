/**
 * @compass/slack-connector — a live chat connector behind `ConnectorPort`.
 *
 * Layer position: beside `@compass/seed-connector`, `@compass/github-connector` and
 * `@compass/jira-connector`, directly above `@compass/connector-port`. Nothing in `ingest`,
 * `knowledge-model`, `analysis`, `renderers`, `narrator`, `memos` or `pipeline` may import this package:
 * the provider is resolved at the composition root and injected, which
 * `tools/quality-gates/tests/provider-neutrality.test.ts` asserts over source text.
 *
 * The proof that this is a drop-in replacement is `tests/contract.test.ts`, which runs
 * `describeConnectorContract` from `@compass/connector-port/testkit` **unchanged** — the same suite the
 * seeded provider passes.
 */
export {
  EmptyChannelSelectionError,
  SLACK_CONNECTOR_ID,
  SlackConnector,
  conversationKindFromKey,
  type SlackChannel,
  type SlackConnectorConfig,
} from './slack-connector.js';

export {
  conversationKeyFromChannelLink,
  exchangeSlackAuthorizationCode,
  type SlackExchangeInput,
  type SlackExchangeOutcome,
} from './oauth.js';

export {
  FORBIDDEN_SLACK_SCOPES,
  SLACK_SCOPES,
  slackInstallUrl,
  slackScopeQuery,
  type SlackScope,
} from './scopes.js';
