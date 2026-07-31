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
  type AuthMailMessage,
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
  DEMO_OWNER_EMAIL,
  DEMO_OWNER_NAME,
  DEMO_OWNER_PASSWORD,
  OWNER_EMAIL_ENV_VAR,
  OWNER_NAME_ENV_VAR,
  OWNER_PASSWORD_ENV_VAR,
  bootstrapOwner,
  describeBootstrapOwner,
  ownerCredentialsAreDefault,
  resolveOwnerCredentials,
  seatReadiness,
  type BootstrapOwnerResult,
  type OwnerCredentials,
  type OwnerEnvironment,
} from './bootstrap.js';
