import { instantFromIso, isAtOrAfter, isBefore, toEpochMillis, type Instant } from '@compass/clock';

import type { FederatedAssertion } from './federated-sign-in.js';
import {
  attributeValue,
  childNamed,
  childrenNamed,
  parseXml,
  textOf,
  verifyXmlSignature,
  type XmlElement,
  type XmlSignatureRefusal,
} from './xml-signature.js';

/**
 * SAML 2.0 Web Browser SSO, the service-provider half, over HTTP-POST.
 *
 * ## The profile Compass accepts, and why it is narrow
 *
 * Every option in SAML is a way for two implementations to disagree, and every disagreement in a
 * *security* protocol is a potential bypass. So Compass implements one profile and refuses the rest,
 * with a named reason for each refusal so an operator gets a diagnosis rather than "login failed":
 *
 *  - **The assertion must be signed.** Not the Response — the assertion. A Response-level signature
 *    says "this envelope came from the IdP" and says nothing about which of the assertions inside it
 *    is trustworthy; requiring the assertion itself to be signed is the setting IdPs call
 *    `WantAssertionsSigned`, and it is the one that makes the claim attributable to the thing making
 *    it. `verifyXmlSignature` additionally requires the signature to be a *direct child* of the
 *    assertion, so one lifted from elsewhere in the document cannot vouch for it.
 *  - **RSA-SHA256, SHA-256 digests, exclusive canonicalisation.** SHA-1 is refused.
 *  - **No encrypted assertions.** `EncryptedAssertion` is refused rather than half-supported: the
 *    transport is already TLS, so encryption adds confidentiality against nothing in this threat
 *    model while adding a whole key-management surface.
 *  - **Unsolicited responses are accepted; `InResponseTo` is checked when present.** IdP-initiated
 *    sign-in is how people actually use a directory's app launcher, so refusing it outright would
 *    break the common case. What replaces the request-id check is everything else here: the signature,
 *    the audience, the recipient, the time window and the replay ledger.
 *
 * ## What is checked, and why each one is not optional
 *
 * A signature proves the IdP said it. It does *not* prove the IdP said it **to Compass**, **now**, or
 * **once** — and each of those is a real attack:
 *
 *  - **Audience.** Without it, an assertion the IdP minted for a *different* service provider is
 *    accepted here. Anybody who can log into any app that federates to the same IdP could replay
 *    their assertion at Compass. This is the check most often missed.
 *  - **Recipient.** Binds the assertion to this ACS URL, so one addressed elsewhere is refused.
 *  - **`NotBefore` / `NotOnOrAfter`.** An assertion is a bearer credential; without a window it is a
 *    permanent password that the holder cannot revoke.
 *  - **Issuer.** Must equal the configured IdP entity id, so a valid assertion from some *other*
 *    directory is refused even if its signature checks out against a certificate somebody pasted.
 *  - **Replay.** Not here — this module is pure. `claimAssertionId` in `@compass/db` does it with a
 *    unique index, because "has this id been used" has to survive a deploy and be shared between the
 *    web and worker processes.
 *
 * ## No clock read
 *
 * `now` is a parameter, as everywhere in this package. It is also what lets the expiry tests choose
 * instants rather than waiting for an assertion to age out.
 */

export const SAML_ASSERTION_NAMESPACE = 'urn:oasis:names:tc:SAML:2.0:assertion';
export const SAML_PROTOCOL_NAMESPACE = 'urn:oasis:names:tc:SAML:2.0:protocol';

/** The `NameID` formats Compass will read a subject from. */
const ACCEPTED_NAME_ID_FORMATS: readonly string[] = Object.freeze([
  'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
]);

/**
 * Attribute names an IdP might use for an email address and a display name.
 *
 * Several spellings because there is no single convention: Azure AD emits the long Claims URIs, Okta
 * and Google emit short names, and Shibboleth emits OID-style names. Checked in order, so the most
 * specific wins.
 */
const EMAIL_ATTRIBUTE_NAMES: readonly string[] = Object.freeze([
  'email',
  'emailaddress',
  'mail',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
]);

const NAME_ATTRIBUTE_NAMES: readonly string[] = Object.freeze([
  'displayname',
  'name',
  'cn',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/displayname',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'urn:oid:2.16.840.1.113730.3.1.241',
]);

/**
 * How much clock skew between Compass and the IdP is tolerated.
 *
 * Sixty seconds, and it applies to `NotBefore` and `NotOnOrAfter` alike. Zero tolerance would make
 * sign-in fail intermittently on any deployment whose clock differs from the IdP's by a second, which
 * is every deployment; a generous window would extend the life of a captured assertion. A minute is
 * the smallest value that does not produce spurious failures, and the replay ledger is what makes the
 * remaining window safe rather than the window's size.
 */
export const SAML_CLOCK_SKEW_MILLIS = 60 * 1000;

export type SamlRefusal =
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'encrypted' }
  | { readonly kind: 'responder_error'; readonly statusCode: string }
  | { readonly kind: 'signature'; readonly reason: XmlSignatureRefusal }
  | { readonly kind: 'issuer_mismatch'; readonly asserted: string }
  | { readonly kind: 'audience_mismatch'; readonly asserted: readonly string[] }
  | { readonly kind: 'recipient_mismatch'; readonly asserted: string }
  | { readonly kind: 'not_yet_valid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'no_subject' }
  | { readonly kind: 'no_email' };

export interface SamlAcceptance {
  readonly assertion: FederatedAssertion;
  /** The assertion's own `ID`, which the caller must claim against the replay ledger. */
  readonly assertionId: string;
  readonly issuer: string;
  /** The end of the validity window, so the ledger row can be pruned once it closes. */
  readonly notOnOrAfter: Instant;
}

export type SamlVerdict =
  | { readonly ok: true; readonly accepted: SamlAcceptance }
  | { readonly ok: false; readonly refusal: SamlRefusal };

export interface SamlVerificationInput {
  /** The decoded `SAMLResponse`, as XML. */
  readonly xml: string;
  /** The IdP's `EntityID`. An assertion from any other issuer is refused. */
  readonly idpEntityId: string;
  /** Base64 DER certificate from IdP metadata, or PEM. */
  readonly idpCertificate: string;
  /** This deployment's own entity id, which the assertion's `Audience` must name. */
  readonly serviceProviderEntityId: string;
  /** This deployment's ACS URL, which `Recipient` must name when present. */
  readonly assertionConsumerServiceUrl: string;
  readonly now: Instant;
}

/** What to tell an operator, in the product's voice. Never leaks which certificate is configured. */
export function describeSamlRefusal(refusal: SamlRefusal): string {
  switch (refusal.kind) {
    case 'malformed':
      return `That sign-in response could not be read: ${refusal.detail}`;
    case 'encrypted':
      return (
        'That response carries an encrypted assertion. Compass verifies signed assertions over TLS and ' +
        'does not implement assertion encryption — turn off assertion encryption at the identity provider.'
      );
    case 'responder_error':
      return (
        `The identity provider refused the sign-in itself (${refusal.statusCode}). Nothing is wrong with ` +
        'Compass’s configuration; the answer is at the provider — most often the user is not assigned to ' +
        'the application.'
      );
    case 'signature':
      return refusal.reason === 'no_signature'
        ? 'That assertion is not signed. Compass requires signed assertions — enable "Sign assertions" at ' +
            'the identity provider, not only response signing.'
        : `That assertion’s signature was refused: ${refusal.reason.replace(/_/g, ' ')}.`;
    case 'issuer_mismatch':
      return (
        'That assertion was issued by a different identity provider than the one configured here, so it ' +
        'is refused even though it is well-formed.'
      );
    case 'audience_mismatch':
      return (
        'That assertion was issued for a different application. An assertion minted for another service ' +
        'provider is not proof of anything here, so Compass refuses it — check the Audience / Entity ID ' +
        'at the identity provider matches this deployment’s.'
      );
    case 'recipient_mismatch':
      return 'That assertion was addressed to a different sign-in URL, so it is refused.';
    case 'not_yet_valid':
      return (
        'That assertion is not valid yet. This is almost always clock skew — check the clock on the ' +
        'identity provider and on this deployment.'
      );
    case 'expired':
      return 'That sign-in has expired. Start again from the sign-in screen.';
    case 'no_subject':
      return 'That assertion names no subject Compass can read, so there is nobody to sign in.';
    case 'no_email':
      return (
        'That assertion carries no email address. Compass matches a seat by verified email, so the ' +
        'identity provider must release an email attribute or use an emailAddress NameID.'
      );
  }
}

const parseInstant = (value: string | null): Instant | null => {
  if (value === null || value.trim().length === 0) return null;
  try {
    return instantFromIso(value.trim());
  } catch {
    return null;
  }
};

/**
 * Verifies a `SAMLResponse` and extracts the one assertion it is willing to trust.
 *
 * Pure: no clock, no database, no network. The replay check is the caller's, because it needs a row.
 */
export function verifySamlResponse(input: SamlVerificationInput): SamlVerdict {
  let document: XmlElement;
  try {
    document = parseXml(input.xml);
  } catch (error) {
    return {
      ok: false,
      refusal: { kind: 'malformed', detail: error instanceof Error ? error.message : 'it is not valid XML.' },
    };
  }

  if (document.namespaceUri !== SAML_PROTOCOL_NAMESPACE || document.localName !== 'Response') {
    return {
      ok: false,
      refusal: { kind: 'malformed', detail: 'the root element is not a SAML 2.0 Response.' },
    };
  }

  /**
   * The IdP's own verdict, read before anything else.
   *
   * A `Responder` or `AuthnFailed` status is the IdP saying "I refused this person" — most often
   * because they are not assigned to the application. Reading it first means the operator is told
   * *that*, rather than "no assertion found", which would send them looking at Compass's config.
   */
  const status = childNamed(document, SAML_PROTOCOL_NAMESPACE, 'Status');
  const statusCode = status === null ? null : childNamed(status, SAML_PROTOCOL_NAMESPACE, 'StatusCode');
  const statusValue = statusCode === null ? null : attributeValue(statusCode, 'Value');

  if (statusValue !== null && statusValue !== 'urn:oasis:names:tc:SAML:2.0:status:Success') {
    return { ok: false, refusal: { kind: 'responder_error', statusCode: statusValue } };
  }

  if (childNamed(document, SAML_ASSERTION_NAMESPACE, 'EncryptedAssertion') !== null) {
    return { ok: false, refusal: { kind: 'encrypted' } };
  }

  const assertions = childrenNamed(document, SAML_ASSERTION_NAMESPACE, 'Assertion');
  if (assertions.length === 0) {
    return { ok: false, refusal: { kind: 'malformed', detail: 'it carries no assertion.' } };
  }
  if (assertions.length > 1) {
    /**
     * Exactly one assertion.
     *
     * Several is legal SAML and is refused here: with two, "which one signed in" becomes a choice this
     * code would be making on the caller's behalf, and picking the first is precisely the behaviour a
     * wrapping attack exploits.
     */
    return {
      ok: false,
      refusal: { kind: 'malformed', detail: 'it carries more than one assertion, which is ambiguous.' },
    };
  }

  const assertion = assertions[0]!;
  const assertionId =
    attributeValue(assertion, 'ID') ?? attributeValue(assertion, 'Id') ?? attributeValue(assertion, 'id');

  if (assertionId === null || assertionId.trim().length === 0) {
    return { ok: false, refusal: { kind: 'malformed', detail: 'the assertion has no ID.' } };
  }

  // ---------------------------------------------------------------------
  // The signature, before any claim inside the assertion is believed.
  // ---------------------------------------------------------------------
  const signature = verifyXmlSignature({
    document,
    signed: assertion,
    certificate: input.idpCertificate,
  });

  if (!signature.ok) return { ok: false, refusal: { kind: 'signature', reason: signature.reason } };

  // ---------------------------------------------------------------------
  // Issuer. Checked after the signature so a forgery and a wrong-IdP assertion are distinguishable.
  // ---------------------------------------------------------------------
  const issuerElement = childNamed(assertion, SAML_ASSERTION_NAMESPACE, 'Issuer');
  const issuer = issuerElement === null ? '' : textOf(issuerElement);

  if (issuer !== input.idpEntityId) {
    return { ok: false, refusal: { kind: 'issuer_mismatch', asserted: issuer } };
  }

  // ---------------------------------------------------------------------
  // Conditions: the validity window and the audience.
  // ---------------------------------------------------------------------
  const conditions = childNamed(assertion, SAML_ASSERTION_NAMESPACE, 'Conditions');

  const notBefore = parseInstant(conditions === null ? null : attributeValue(conditions, 'NotBefore'));
  const conditionsNotOnOrAfter = parseInstant(
    conditions === null ? null : attributeValue(conditions, 'NotOnOrAfter'),
  );

  if (notBefore !== null && isBefore(input.now, skew(notBefore, -SAML_CLOCK_SKEW_MILLIS))) {
    return { ok: false, refusal: { kind: 'not_yet_valid' } };
  }
  if (
    conditionsNotOnOrAfter !== null &&
    isAtOrAfter(input.now, skew(conditionsNotOnOrAfter, SAML_CLOCK_SKEW_MILLIS))
  ) {
    return { ok: false, refusal: { kind: 'expired' } };
  }

  /**
   * The audience restriction — the check that stops a cross-service replay.
   *
   * Required rather than optional. An assertion with no `AudienceRestriction` is one the IdP has not
   * said is *for Compass*, and accepting it means anybody who can sign into any application federated
   * to the same IdP can present their assertion here. So a missing restriction is refused with the
   * same reason as a wrong one, and the sentence tells the operator which setting to fix.
   */
  const audiences =
    conditions === null
      ? []
      : childrenNamed(conditions, SAML_ASSERTION_NAMESPACE, 'AudienceRestriction').flatMap((restriction) =>
          childrenNamed(restriction, SAML_ASSERTION_NAMESPACE, 'Audience').map((audience) => textOf(audience)),
        );

  if (!audiences.includes(input.serviceProviderEntityId)) {
    return { ok: false, refusal: { kind: 'audience_mismatch', asserted: audiences } };
  }

  // ---------------------------------------------------------------------
  // The subject, its confirmation, and the tighter of the two expiry windows.
  // ---------------------------------------------------------------------
  const subject = childNamed(assertion, SAML_ASSERTION_NAMESPACE, 'Subject');
  if (subject === null) return { ok: false, refusal: { kind: 'no_subject' } };

  const nameId = childNamed(subject, SAML_ASSERTION_NAMESPACE, 'NameID');
  const nameIdValue = nameId === null ? '' : textOf(nameId);
  const nameIdFormat = nameId === null ? null : attributeValue(nameId, 'Format');

  if (nameIdValue.length === 0) return { ok: false, refusal: { kind: 'no_subject' } };
  if (nameIdFormat !== null && !ACCEPTED_NAME_ID_FORMATS.includes(nameIdFormat)) {
    return {
      ok: false,
      refusal: { kind: 'malformed', detail: `the NameID format \`${nameIdFormat}\` is not one Compass reads.` },
    };
  }

  let confirmationNotOnOrAfter: Instant | null = null;

  for (const confirmation of childrenNamed(subject, SAML_ASSERTION_NAMESPACE, 'SubjectConfirmation')) {
    const data = childNamed(confirmation, SAML_ASSERTION_NAMESPACE, 'SubjectConfirmationData');
    if (data === null) continue;

    /**
     * `Recipient` binds the assertion to this ACS URL.
     *
     * Compared only when present, because it is optional in the specification — but when the IdP does
     * state it, an assertion addressed somewhere else must not be accepted here.
     */
    const recipient = attributeValue(data, 'Recipient');
    if (recipient !== null && recipient.length > 0 && recipient !== input.assertionConsumerServiceUrl) {
      return { ok: false, refusal: { kind: 'recipient_mismatch', asserted: recipient } };
    }

    const dataNotOnOrAfter = parseInstant(attributeValue(data, 'NotOnOrAfter'));
    if (dataNotOnOrAfter !== null) {
      if (isAtOrAfter(input.now, skew(dataNotOnOrAfter, SAML_CLOCK_SKEW_MILLIS))) {
        return { ok: false, refusal: { kind: 'expired' } };
      }
      confirmationNotOnOrAfter =
        confirmationNotOnOrAfter === null
          ? dataNotOnOrAfter
          : toEpochMillis(dataNotOnOrAfter) < toEpochMillis(confirmationNotOnOrAfter)
            ? dataNotOnOrAfter
            : confirmationNotOnOrAfter;
    }
  }

  // ---------------------------------------------------------------------
  // The attributes Compass needs.
  // ---------------------------------------------------------------------
  const attributes = readAttributes(assertion);

  const emailFromAttributes = firstAttribute(attributes, EMAIL_ATTRIBUTE_NAMES);
  const nameIdIsEmail =
    nameIdFormat === 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' ||
    (nameIdFormat === null && nameIdValue.includes('@'));

  const email = (emailFromAttributes ?? (nameIdIsEmail ? nameIdValue : '')).trim().toLowerCase();
  if (email.length === 0 || !email.includes('@')) return { ok: false, refusal: { kind: 'no_email' } };

  const displayName = firstAttribute(attributes, NAME_ATTRIBUTE_NAMES) ?? email;

  /**
   * The ledger's pruning deadline: whichever window closes first, or an hour if the IdP stated none.
   *
   * The fallback matters. `not_on_or_after` is what lets a spent id be pruned, and a row with no
   * deadline would either never be pruned (the table grows forever) or be pruned immediately (the
   * replay defence evaporates). An hour is longer than any legitimate assertion lifetime, so it is
   * safe in the direction that counts.
   */
  const notOnOrAfter =
    confirmationNotOnOrAfter ?? conditionsNotOnOrAfter ?? skew(input.now, 60 * 60 * 1000);

  return {
    ok: true,
    accepted: {
      assertionId: assertionId.trim(),
      issuer,
      notOnOrAfter,
      assertion: {
        provider: 'saml',
        /**
         * The `NameID` is the subject, not the email.
         *
         * Same rule as the OAuth providers and for the same reason: a directory's NameID is stable
         * across a rename, and an email address is not.
         */
        subject: nameIdValue,
        email,
        /**
         * True, and this is the one place that deserves justifying.
         *
         * An address in a signed assertion from the organization's *own* identity provider is not the
         * same thing as an address a consumer OAuth account typed in. The IdP is the authority for
         * that namespace — it is the system that provisions the mailboxes — so its assertion *is* the
         * verification. This is why SAML may provision a seat and Google sign-in may not.
         */
        emailVerified: true,
        displayName,
      },
    },
  };
}

const skew = (instant: Instant, millis: number): Instant =>
  instantFromIso(new Date(toEpochMillis(instant) + millis).toISOString());

interface SamlAttribute {
  readonly name: string;
  readonly values: readonly string[];
}

function readAttributes(assertion: XmlElement): readonly SamlAttribute[] {
  const statements = childrenNamed(assertion, SAML_ASSERTION_NAMESPACE, 'AttributeStatement');

  return statements.flatMap((statement) =>
    childrenNamed(statement, SAML_ASSERTION_NAMESPACE, 'Attribute').map((attribute) => ({
      // Lower-cased for matching: IdPs disagree about capitalisation of even the short names.
      name: (attributeValue(attribute, 'Name') ?? '').trim().toLowerCase(),
      values: childrenNamed(attribute, SAML_ASSERTION_NAMESPACE, 'AttributeValue').map((value) => textOf(value)),
    })),
  );
}

const firstAttribute = (
  attributes: readonly SamlAttribute[],
  candidates: readonly string[],
): string | null => {
  for (const candidate of candidates) {
    const found = attributes.find((attribute) => attribute.name === candidate);
    const value = found?.values.find((entry) => entry.trim().length > 0);
    if (value !== undefined) return value.trim();
  }
  return null;
};

// ---------------------------------------------------------------------------
// Service-provider metadata
// ---------------------------------------------------------------------------

/**
 * The SP metadata an IdP is configured from.
 *
 * Generated rather than hand-written, so the entity id and the ACS URL in the document are the same
 * values the ACS route actually enforces. A metadata file that disagreed with the code would send
 * every operator down a debugging path that ends at a check they cannot see.
 *
 * `WantAssertionsSigned="true"` and `AuthnRequestsSigned="false"` are both stated deliberately: the
 * first is the requirement this module enforces, and the second is honest — Compass does not sign its
 * requests, because it accepts unsolicited (IdP-initiated) responses anyway, so a signed request would
 * be a promise the verification path does not rely on.
 */
export function samlServiceProviderMetadata(input: {
  readonly entityId: string;
  readonly assertionConsumerServiceUrl: string;
}): string {
  const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" ' +
    `entityID="${escape(input.entityId)}">\n` +
    '  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" ' +
    'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">\n' +
    '    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>\n' +
    '    <md:AssertionConsumerService ' +
    'Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" ' +
    `Location="${escape(input.assertionConsumerServiceUrl)}" index="0" isDefault="true"/>\n` +
    '  </md:SPSSODescriptor>\n' +
    '</md:EntityDescriptor>\n'
  );
}
