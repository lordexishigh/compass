/**
 * @compass/auth — identity, sessions, the four-role matrix and the seat lifecycle.
 *
 * Layer position: directly above `@compass/db`, and beside the knowledge model rather
 * than beneath it. It needs the seat and session rows and nothing else; the report
 * path must never import it, which `.dependency-cruiser.cjs` enforces under
 * `authorization-is-not-a-report-concern`. A section whose content could depend on who
 * was looking would make the determinism gate meaningless.
 *
 * Nothing here reads a clock. Every function that cares about time takes
 * `now: Instant` as a parameter, the same rule the analysis core lives under, which
 * is what lets the session-expiry tests choose instants instead of waiting a month.
 */

export {
  ARGON2ID_PARAMETERS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  WeakPasswordError,
  assertUsablePassword,
  describePasswordHash,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from './password.js';

export {
  SECRET_BYTES,
  TOKEN_TTL_LABEL,
  TOKEN_TTL_MILLIS,
  describeTokenRejection,
  digestSecret,
  digestsMatch,
  issueSecret,
  tokenExpiryFor,
  tokenRejection,
  type IssuedSecret,
  type PresentedToken,
  type TokenRejection,
} from './secrets.js';

/**
 * TOTP and recovery codes.
 *
 * Pure functions with `now` as a parameter — no clock read, no database — so the replay property is
 * asserted by stepping time deliberately rather than by sleeping thirty seconds.
 */
export {
  InvalidBase32Error,
  RECOVERY_CODE_COUNT,
  TOTP_ACCEPTED_DRIFT_STEPS,
  TOTP_DIGITS,
  TOTP_SECRET_BYTES,
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchRecoveryCode,
  normaliseRecoveryCode,
  totpCodeForStep,
  totpEnrollmentUri,
  totpStepFor,
  verifyTotpCode,
  type TotpVerdict,
} from './totp.js';

/**
 * The signed ticket that carries a sign-in from the password step to the code step.
 *
 * Separate from `totp.ts` because it is not the algorithm — it is the reason a password alone mints no
 * session. See the module for why it is signed rather than stored.
 */
export {
  SECOND_FACTOR_CHALLENGE_SECRET_ENV_VAR,
  SECOND_FACTOR_CHALLENGE_TTL_MILLIS,
  describeChallengeRejection,
  issueSecondFactorChallenge,
  verifySecondFactorChallenge,
  type SecondFactorChallengeVerdict,
} from './second-factor-challenge.js';

/**
 * Sign-in with Google and with GitHub.
 *
 * The protocol and the configuration only: the account-matching rules live in `federated-sign-in.ts`
 * because SAML needs exactly the same ones, and two copies of "never auto-link an unverified address"
 * is two chances to get it wrong.
 */
export {
  SSO_ENV_VARS,
  SSO_PROVIDERS,
  SSO_PROVIDER_DEFINITIONS,
  SSO_STATE_SECRET_ENV_VAR,
  SSO_STATE_TTL_MILLIS,
  configuredSsoProviders,
  describeSsoStateRejection,
  fetchSsoProfile,
  generateSsoNonce,
  isSsoProvider,
  issueSsoState,
  ssoAuthorizeUrl,
  ssoCredentials,
  verifySsoState,
  type SsoClientCredentials,
  type SsoEnvironment,
  type SsoHttpClient,
  type SsoHttpRequest,
  type SsoHttpResponse,
  type SsoProfile,
  type SsoProfileResult,
  type SsoProvider,
  type SsoProviderDefinition,
  type SsoState,
  type SsoStateVerdict,
} from './oauth.js';

/** One set of account-matching rules for Google, GitHub and SAML alike. */
export {
  describeFederatedRefusal,
  linkIdentityToAccount,
  resolveFederatedSignIn,
  type FederatedAssertion,
  type FederatedRefusal,
  type FederatedSignIn,
  type FederatedSignInInput,
  type IdentityLinkResult,
} from './federated-sign-in.js';

/**
 * XML canonicalisation and signature verification, for SAML.
 *
 * Exported from the barrel rather than kept private because its tests are the load-bearing ones: a
 * canonicaliser is only trustworthy if the refusals can be asserted directly.
 */
export {
  DSIG_NAMESPACE,
  XMLNS,
  XmlParseError,
  attributeValue,
  canonicalizeExclusive,
  certificateToPem,
  childNamed,
  childrenNamed,
  describeXmlSignatureRefusal,
  elementChildren,
  findElementsById,
  parseXml,
  textOf,
  verifyXmlSignature,
  type XmlAttribute,
  type XmlElement,
  type XmlNode,
  type XmlSignatureRefusal,
  type XmlSignatureVerdict,
  type XmlText,
} from './xml-signature.js';

/**
 * SAML 2.0 Web Browser SSO, service-provider side.
 *
 * Pure: `verifySamlResponse` takes `now` and returns a verdict. The replay check is deliberately
 * *not* here — it needs a unique index, and `claimAssertionId` in `@compass/db` is where it lives.
 */
export {
  SAML_ASSERTION_NAMESPACE,
  SAML_CLOCK_SKEW_MILLIS,
  SAML_PROTOCOL_NAMESPACE,
  describeSamlRefusal,
  samlServiceProviderMetadata,
  verifySamlResponse,
  type SamlAcceptance,
  type SamlRefusal,
  type SamlVerdict,
  type SamlVerificationInput,
} from './saml.js';

/** SCIM 2.0 provisioning. A SCIM User *is* a Compass seat — see the module header for why. */
export {
  SCIM_ERROR_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_PATCH_SCHEMA,
  SCIM_TOKEN_BYTES,
  SCIM_USER_SCHEMA,
  authenticateScim,
  bearerTokenFrom,
  externalIdFor,
  generateScimToken,
  hashScimToken,
  parseScimFilter,
  readScimPatch,
  readScimUserWrite,
  scimError,
  scimListUsers,
  scimUserResource,
  type ScimAuthentication,
  type ScimFilter,
  type ScimListResponse,
  type ScimPatchIntent,
  type ScimUserResource,
  type ScimUserWrite,
  type ScimWriteResult,
} from './scim.js';

export {
  SESSION_ABSOLUTE_TTL_DAYS,
  SESSION_ABSOLUTE_TTL_MILLIS,
  SESSION_IDLE_TTL_DAYS,
  SESSION_IDLE_TTL_MILLIS,
  SESSION_REVOKE_REASONS,
  SESSION_TOUCH_INTERVAL_MILLIS,
  describeSessionRejection,
  sessionAbsoluteExpiry,
  sessionDeadline,
  sessionIdleExpiry,
  sessionRejection,
  shouldTouchSession,
  type SessionRejection,
  type SessionRevokeReason,
} from './sessions.js';

export {
  ACTIONS,
  MATRIX_ROUTES,
  PRINCIPALS,
  ROLE_CAPABILITIES,
  ROLE_MATRIX,
  STATUS_FOR_DENIAL,
  authorize,
  describeDenial,
  findRouteRule,
  isPublicRoute,
  roleIsTeamUnscoped,
  teamScopeAllows,
  type Action,
  type AuthorizeDecision,
  type AuthorizeRequest,
  type DenialReason,
  type Principal,
  type RouteRule,
} from './matrix.js';

export {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABEL,
  changedKeys,
  isAuditAction,
  recordAudit,
  type AuditAction,
  type AuditRecordInput,
} from './audit.js';

export {
  ConsoleMailer,
  RecordingMailer,
  composeAuthMail,
  composeDeletionConfirmationMail,
  composeDeletionUndoMail,
  composeDunningMail,
  composeLockoutMail,
  composeScimTokenMail,
  composeSubprocessorChangeMail,
  composeSubprocessorConfirmationMail,
  type AuthMailMessage,
  type AuthMailPurpose,
  type AuthMailer,
} from './mailer.js';

export {
  AuthRequestError,
  consumeMagicLink,
  consumePasswordReset,
  describeLoginFailure,
  endAllSessions,
  endSession,
  hasOwner,
  looksLikeEmail,
  registerAccount,
  renameAccount,
  resolveIdentity,
  rotateSessionsForPrivilegeChange,
  startSession,
  verifyLogin,
  type ConsumeResult,
  type Identity,
  type IdentityResolution,
  type LinkRequestInput,
  type LinkRequestResult,
  type LoginFailure,
  type LoginResult,
  type RegisterInput,
  type RegisteredAccount,
  type StartedSession,
} from './accounts.js';

export { requestMagicLink, requestPasswordReset } from './accounts.js';

export {
  LastOwnerError,
  SEAT_ROLES,
  SeatNotFoundError,
  acceptInvite,
  changeSeat,
  inviteSeat,
  isSeatRole,
  readSeats,
  removeSeat,
  resendInvite,
  revokeInvite,
  type AcceptResult,
  type InviteInput,
  type InviteResult,
  type SeatChangeInput,
  type SeatChangeResult,
} from './seats.js';

export {
  DEMO_ACCOUNT_LOGIN_PATH,
  DEMO_OWNER_EMAIL,
  DEMO_OWNER_NAME,
  GENERATED_PASSWORD_BYTES,
  OWNER_EMAIL_ENV_VAR,
  OWNER_NAME_ENV_VAR,
  OWNER_PASSWORD_ENV_VAR,
  MissingOwnerPasswordError,
  OwnerConfigurationError,
  bootstrapOwner,
  configuredOwnerPassword,
  describeBootstrapOwner,
  generateOwnerPassword,
  ownerConfigurationProblem,
  ownerCredentialsAreDefault,
  resolveOwnerCredentials,
  seatReadiness,
  type BootstrapOwnerResult,
  type OwnerCredentials,
  type OwnerEnvironment,
} from './bootstrap.js';

export {
  LOCKOUT_BASE_MILLIS,
  LOCKOUT_MAX_MILLIS,
  RATE_LIMITED_ACTIONS,
  RATE_LIMIT_POLICIES,
  countAttempt,
  describeRateLimit,
  emptyWindow,
  lockoutDurationFor,
  secondsUntil,
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateLimitSubject,
  type RateLimitWindow,
  type RateLimitedAction,
} from './rate-limit.js';

export {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  GITHUB_SIGNATURE_PREFIX,
  JIRA_AUTHORIZATION_HEADER,
  JIRA_SIGNATURE_HEADER,
  WEBHOOK_PROVIDERS,
  WEBHOOK_SECRET_ENV_VAR,
  WEBHOOK_TIMESTAMP_WINDOW_MILLIS,
  WEBHOOK_TIMESTAMP_WINDOW_SECONDS,
  constantTimeEqual,
  describeWebhookVerdict,
  githubSignatureFor,
  isWebhookAccepted,
  isWebhookProvider,
  jiraJwtFor,
  jiraSignatureFor,
  slackWebhookVerdict,
  verifyGithubSignature,
  verifyJiraSignature,
  type GithubSignatureInput,
  type JiraSignatureInput,
  type WebhookProvider,
  type WebhookVerdict,
} from './webhooks.js';

export {
  DATA_KEY_BYTES,
  ENVELOPE_SCHEME,
  EnvelopeDecryptionError,
  MASTER_KEY_ENV_VAR,
  MasterKeyUnavailableError,
  generateDataKey,
  reencryptUnderNewKey,
  resolveMasterKey,
  rewrapDataKey,
  seal,
  unseal,
  unwrapDataKey,
  wrapDataKey,
  type SealInput,
  type SealedValue,
  type UnsealInput,
} from './envelope.js';

export {
  describeIntegrationToken,
  describeIntegrationTokens,
  rewrapOrganizationDataKey,
  rotateOrganizationDataKey,
  storeIntegrationToken,
  useIntegrationToken,
  type IntegrationTokenDescription,
  type StoreTokenInput,
} from './integration-tokens.js';
