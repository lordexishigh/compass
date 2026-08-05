export {
  EmptyProjectSelectionError,
  JIRA_CONNECTOR_ID,
  JiraConnector,
  // Exported so the recorded fixture builds its keys from the same query strings the connector sends.
  // A fixture with its own hand-written copy of the JQL proves the recording is self-consistent and
  // nothing about the connector.
  sprintMembershipJql,
  updatedSinceJql,
  type JiraConnectorConfig,
  type JiraProject,
} from './jira-connector.js';

export {
  exchangeJiraAuthorizationCode,
  listJiraProjects,
  type JiraExchangeInput,
  type JiraExchangeOutcome,
  type JiraProjectOption,
} from './oauth.js';

export {
  FORBIDDEN_JIRA_SCOPES,
  JIRA_OFFLINE_SCOPE,
  JIRA_SCOPES,
  jiraAuthorizeUrl,
  jiraScopeQuery,
  type JiraScope,
} from './scopes.js';
