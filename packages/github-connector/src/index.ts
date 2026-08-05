/**
 * @compass/github-connector — a live code connector behind `ConnectorPort`.
 *
 * Layer position: beside `@compass/seed-connector`, directly above `@compass/connector-port`. Nothing
 * in `ingest`, `knowledge-model`, `analysis`, `renderers` or `pipeline` may import this package: the
 * provider is resolved at the composition root and injected, which is what
 * `tools/quality-gates/tests/provider-neutrality.test.ts` asserts.
 *
 * The proof that this is a drop-in replacement is `tests/contract.test.ts`, which runs
 * `describeConnectorContract` from `@compass/connector-port/testkit` **unchanged** — the same suite
 * the seeded provider passes.
 */
export {
  EmptyRepositorySelectionError,
  GITHUB_CONNECTOR_ID,
  GithubConnector,
  type GithubConnectorConfig,
  type GithubRepository,
} from './github-connector.js';

export {
  FORBIDDEN_GITHUB_PERMISSIONS,
  GITHUB_SCOPES,
  githubInstallUrl,
  githubPermissionQuery,
  type GithubScope,
} from './scopes.js';
