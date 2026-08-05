import {
  SSO_PROVIDER_DEFINITIONS,
  SSO_PROVIDERS,
  configuredSsoProviders,
  describeFederatedRefusal,
  samlServiceProviderMetadata,
  type SsoProvider,
} from '@compass/auth';
import {
  ENTERPRISE_IDENTITY_REQUIRED_STATEMENT,
  isPlanId,
  planIncludesEnterpriseIdentity,
} from '@compass/billing';
import {
  findBillingSubscription,
  findSamlConnection,
  listIdentitiesForUser,
  listScimCredentials,
  samlConnectionIsEnabled,
  type ScopedDb,
  type StoredScimCredential,
  type StoredUserIdentity,
} from '@compass/db';

/**
 * Everything the sign-in panel, the account screen and the enterprise screen read about federated
 * identity.
 *
 * ## The rule this module keeps
 *
 * **The scope list is never written twice.** `SSO_PROVIDER_DEFINITIONS` in `@compass/auth` is the one
 * declaration; the authorization URL is built from it and the consent screen renders *this array*.
 * Same reasoning `lib/connect-source.ts` records for the GitHub App: two copies of a scope list is the
 * shape where the screen keeps promising a narrow read after somebody widens the request, and it is
 * invisible in review because both halves look right on their own.
 *
 * ## Where the redirect URI comes from, and where it does not
 *
 * From `baseUrlFor`, which reads `COMPASS_BASE_URL` or a loopback Host and refuses to guess otherwise.
 * Never from `x-forwarded-host`: a caller who chose the redirect target would choose where somebody
 * else's authorization code was delivered. `lib/auth/guard.ts` makes the same argument at length for
 * mailed links, and it is sharper here — an authorization code is a credential in flight.
 */

/** Where a provider returns to. Must match the redirect URI registered with the provider. */
export const ssoCallbackPath = (provider: SsoProvider): string => `/api/auth/sso/${provider}/callback`;

export const ssoRedirectUri = (baseUrl: string, provider: SsoProvider): string =>
  `${baseUrl}${ssoCallbackPath(provider)}`;

/** What the sign-in panel shows for one provider. */
export interface SsoButtonView {
  readonly provider: SsoProvider;
  readonly name: string;
  /** `/api/auth/sso/google` — a plain link, so the panel needs no client JavaScript. */
  readonly startPath: string;
  /** The scope list, verbatim from the connector definition. Never literals in JSX. */
  readonly scopes: readonly string[];
  /** One sentence saying what Compass will read, shown before consent. */
  readonly reads: string;
}

export const ssoButtons = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly SsoButtonView[] =>
  configuredSsoProviders(environment).map((provider) => ({
    provider,
    name: SSO_PROVIDER_DEFINITIONS[provider].name,
    startPath: `/api/auth/sso/${provider}`,
    // The one declaration, rendered as-is. See the module header.
    scopes: SSO_PROVIDER_DEFINITIONS[provider].scopes,
    reads: SSO_PROVIDER_DEFINITIONS[provider].reads,
  }));

/**
 * What `/account` says about the outcome of a round-trip.
 *
 * Here rather than in the callback route because both need it — the route chooses the outcome and the
 * page prints the sentence — and a route file may only export HTTP handlers. Every wording is in the
 * product's own voice and says what to do next, because a sign-in that failed silently is the single
 * most frustrating state this product can leave somebody in.
 */
export const SSO_OUTCOME_STATEMENTS: Readonly<Record<string, string>> = Object.freeze({
  linked: 'That provider is now linked to your account. You can sign in with it from now on.',
  unlinked: 'That provider is no longer linked to your account.',
  'already-linked-elsewhere':
    'That provider account is already linked to a different Compass seat, so it was not linked to this ' +
    'one. A provider account belongs to one person here.',
  cancelled: 'That sign-in was cancelled. Nothing changed.',
  'email-unverified': describeFederatedRefusal('email_unverified', 'That provider'),
  'no-seat': describeFederatedRefusal('no_seat', 'That provider'),
  'seat-revoked': describeFederatedRefusal('seat_revoked', 'That provider'),
  'no-email':
    'That provider did not release an email address, so Compass has no way to find your seat. Add a ' +
    'primary address to the provider account and try again.',
  'not-configured':
    'Single sign-on is not configured on this deployment, so that sign-in could not be completed.',
  'state-rejected':
    'That sign-in could not be completed — it may have expired, or it was started in a different ' +
    'browser. Start again from this screen.',
  'no-code': 'That sign-in came back without an authorization code, so it could not be completed.',
  'exchange-failed':
    'The provider would not confirm that sign-in. Try again; if it keeps happening, the deployment’s ' +
    'client credentials for that provider may be wrong.',
  'provider-error': 'The provider reported an error with that sign-in. Nothing changed here.',
  'second-factor':
    'That provider confirmed who you are. Your account also has two-factor authentication on, so enter ' +
    'the code from your authenticator app to finish signing in.',
  'second-factor-unconfigured':
    'Your account has two-factor authentication on, and this deployment cannot issue a code prompt. An ' +
    'administrator has to set COMPASS_SECOND_FACTOR_CHALLENGE_SECRET.',
  'unknown-provider': 'Compass signs in with Google and GitHub. That was neither.',
  'not-linked': 'That provider was not linked to your account, so there was nothing to remove.',
  failed: 'That sign-in could not be completed. Nothing changed.',
});

/** The sentence for an outcome, or null for one Compass does not recognise. */
export const ssoOutcomeStatement = (outcome: string | null): string | null =>
  outcome === null ? null : (SSO_OUTCOME_STATEMENTS[outcome] ?? null);

/**
 * What `/account` says when a SAML sign-in was refused, keyed by a slug the ACS route chooses.
 *
 * ## Why the sentence is looked up here rather than carried in the URL
 *
 * The obvious implementation is `?saml=refused&detail=<the sentence>`, and it is wrong. The page would
 * then print whatever a visitor put in the query string — so anybody could hand somebody a Compass URL
 * that displays "Your account is locked, call this number", in Compass's own typography, on Compass's
 * own domain. React escapes the markup, so it is not script injection; it is a phishing surface, which
 * is worse in the sense that it works on people rather than on browsers.
 *
 * Keying on a slug from a closed set means the wording is always Compass's. The slugs are coarse on
 * purpose — several distinct signature refusals collapse into one — because *which* check failed is a
 * tuning signal for anybody probing the endpoint, and the operator-facing detail belongs in the
 * deployment's own logs rather than in a URL a stranger can read.
 */
export const SAML_REFUSAL_STATEMENTS: Readonly<Record<string, string>> = Object.freeze({
  not_allowed: ENTERPRISE_IDENTITY_REQUIRED_STATEMENT,
  not_configured:
    'SAML single sign-on is not configured for this organization, so there is no identity provider whose ' +
    'assertions Compass would trust. An owner can configure one from the enterprise screen.',
  no_response: 'That request carried no SAML response, so there was nothing to verify.',
  malformed:
    'That sign-in response could not be read. If this keeps happening, the identity provider’s ' +
    'configuration and this deployment’s expectations disagree — the enterprise screen lists what Compass ' +
    'requires.',
  signature:
    'That assertion’s signature was not accepted, so Compass will not act on it. The usual cause is that ' +
    'the certificate configured here is not the one the identity provider is signing with, or that ' +
    'assertion signing is switched off — Compass requires signed assertions, not only signed responses.',
  audience:
    'That assertion was issued for a different application, so it is not proof of anything here. Check ' +
    'that the Audience or Entity ID at the identity provider matches the one on the enterprise screen.',
  expired:
    'That sign-in has expired, or the clocks on this deployment and the identity provider disagree by more ' +
    'than a minute. Start again from your identity provider.',
  provider_refused:
    'Your identity provider refused the sign-in itself. Nothing is wrong with Compass’s configuration — ' +
    'most often the account is not assigned to the Compass application.',
  encrypted:
    'That response carries an encrypted assertion. Compass verifies signed assertions over TLS and does ' +
    'not implement assertion encryption — turn assertion encryption off at the identity provider.',
  no_email:
    'That assertion carries no email address. Compass matches a seat by email, so the identity provider ' +
    'must release an email attribute or use an emailAddress NameID.',
  no_seat:
    'Your identity provider confirmed who you are, but that address has no seat here and provisioning did ' +
    'not create one. Ask an owner to check the SAML configuration.',
  seat_revoked: 'That seat has been removed. Ask an owner for a new invitation.',
  replayed:
    'That sign-in could not be completed. Start again from your identity provider rather than reloading ' +
    'this page.',
  unavailable: 'Compass could not reach its database, so that sign-in could not be completed.',
  failed: 'That sign-in could not be completed. Nothing changed.',
});

export const samlRefusalStatement = (slug: string | null): string | null =>
  slug === null ? null : (SAML_REFUSAL_STATEMENTS[slug] ?? SAML_REFUSAL_STATEMENTS['failed'] ?? null);

/** Every provider Compass supports, configured or not — for the account screen's link list. */
export interface LinkedIdentityView {
  readonly provider: SsoProvider;
  readonly name: string;
  readonly linked: boolean;
  /** The address the provider asserted, when linked. */
  readonly email: string | null;
  readonly lastSignInAt: number | null;
  /** Null when this provider is configured; a sentence when the deployment cannot offer it. */
  readonly unavailableReason: string | null;
  readonly startPath: string;
}

export async function buildLinkedIdentities(input: {
  readonly scoped: ScopedDb;
  readonly userId: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<readonly LinkedIdentityView[]> {
  const environment = input.environment ?? process.env;
  const configured = new Set(configuredSsoProviders(environment));
  const identities = await listIdentitiesForUser(input.scoped, input.userId);

  return SSO_PROVIDERS.map((provider) => {
    const definition = SSO_PROVIDER_DEFINITIONS[provider];
    const identity: StoredUserIdentity | undefined = identities.find(
      (entry) => entry.provider === provider,
    );

    return {
      provider,
      name: definition.name,
      linked: identity !== undefined,
      email: identity?.email ?? null,
      lastSignInAt: identity?.lastSignInAt ?? null,
      unavailableReason: configured.has(provider)
        ? null
        : `${definition.name} sign-in is not configured on this deployment. An operator has to set ` +
          `${definition.clientIdEnvVar} and ${definition.clientSecretEnvVar}.`,
      startPath: `/api/auth/sso/${provider}`,
    };
  });
}

// ---------------------------------------------------------------------------
// SAML and SCIM
// ---------------------------------------------------------------------------

/** This deployment's SAML entity id. Its own base URL, which is what IdPs expect. */
export const samlEntityId = (baseUrl: string): string => `${baseUrl}/api/auth/saml/metadata`;

export const SAML_ACS_PATH = '/api/auth/saml/acs';

export const samlAcsUrl = (baseUrl: string): string => `${baseUrl}${SAML_ACS_PATH}`;

/** The SP metadata document, built from the same values the ACS route enforces. */
export const samlMetadataFor = (baseUrl: string): string =>
  samlServiceProviderMetadata({
    entityId: samlEntityId(baseUrl),
    assertionConsumerServiceUrl: samlAcsUrl(baseUrl),
  });

/**
 * Whether this organization's plan may use SAML and SCIM.
 *
 * Reads the plan id off the subscription row and asks `@compass/billing` — never a string comparison
 * against a plan *name*, which is the version of this gate that breaks the day a fourth plan appears.
 * A missing subscription answers false; `planIncludesEnterpriseIdentity` explains why that direction.
 */
export async function enterpriseIdentityAllowed(scoped: ScopedDb): Promise<boolean> {
  const subscription = await findBillingSubscription(scoped);
  const stored = subscription?.planId ?? null;

  /**
   * Validated rather than cast.
   *
   * The stored plan id is a `text` column written from a Stripe webhook, so it is a `string` and not a
   * `PlanId` — and the difference is load-bearing here: a row holding a plan name this build no longer
   * knows (a renamed plan, a hand-edited row) must fall through to *refused* rather than be asserted
   * into the type and silently opened. `isPlanId` is the plan table's own guard, so the check and the
   * table cannot disagree.
   */
  return planIncludesEnterpriseIdentity(stored !== null && isPlanId(stored) ? stored : null);
}

export interface EnterpriseIdentityView {
  readonly allowed: boolean;
  /** Null when allowed; the plan sentence when not. */
  readonly blockedStatement: string | null;
  readonly entityId: string;
  readonly acsUrl: string;
  readonly metadataUrl: string;
  readonly saml: {
    readonly configured: boolean;
    readonly enabled: boolean;
    readonly idpEntityId: string | null;
    readonly idpSsoUrl: string | null;
    readonly defaultRole: string | null;
    /**
     * A fingerprint of the configured certificate, never the certificate.
     *
     * The certificate is public, so this is not a secrecy measure — it is a *usability* one. An
     * operator's real question is "is the certificate Compass holds the one my IdP is signing with",
     * and comparing 40 hex characters answers it where comparing 1,400 base64 characters does not.
     */
    readonly certificateFingerprint: string | null;
  };
  readonly scim: {
    readonly credentials: readonly StoredScimCredential[];
    readonly usersUrl: string;
  };
}

/** SHA-1 of the DER, hex, colon-separated — the form every IdP console prints. */
export async function certificateFingerprint(base64Der: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha1').update(Buffer.from(base64Der.replace(/\s+/g, ''), 'base64')).digest('hex');
  return (digest.match(/.{2}/g) ?? []).join(':').toUpperCase();
}

export async function buildEnterpriseIdentityView(input: {
  readonly scoped: ScopedDb;
  readonly baseUrl: string;
}): Promise<EnterpriseIdentityView> {
  const allowed = await enterpriseIdentityAllowed(input.scoped);
  const connection = await findSamlConnection(input.scoped);
  const credentials = await listScimCredentials(input.scoped);

  return {
    allowed,
    blockedStatement: allowed ? null : ENTERPRISE_IDENTITY_REQUIRED_STATEMENT,
    entityId: samlEntityId(input.baseUrl),
    acsUrl: samlAcsUrl(input.baseUrl),
    metadataUrl: `${input.baseUrl}/api/auth/saml/metadata`,
    saml: {
      configured: connection !== null,
      enabled: connection !== null && samlConnectionIsEnabled(connection),
      idpEntityId: connection?.idpEntityId ?? null,
      idpSsoUrl: connection?.idpSsoUrl ?? null,
      defaultRole: connection?.defaultRole ?? null,
      certificateFingerprint:
        connection === null ? null : await certificateFingerprint(connection.idpCertificate),
    },
    scim: {
      credentials,
      usersUrl: `${input.baseUrl}/api/scim/v2/Users`,
    },
  };
}
