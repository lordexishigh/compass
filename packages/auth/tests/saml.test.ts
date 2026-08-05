import { createHash, createSign, generateKeyPairSync } from 'node:crypto';

import {
  SAML_CLOCK_SKEW_MILLIS,
  canonicalizeExclusive,
  describeSamlRefusal,
  parseXml,
  resolveFederatedSignIn,
  samlServiceProviderMetadata,
  verifySamlResponse,
  type SamlVerdict,
} from '@compass/auth';
import { instantFromIso, type Instant } from '@compass/clock';
import {
  claimAssertionId,
  ensureMembership,
  ensureUser,
  findIdentityBySubject,
  findMembershipByUserId,
  listSeats,
  userRowId,
} from '@compass/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuthHarness, type AuthHarness } from './helpers/org.js';

/**
 * SAML 2.0 sign-in: the semantic checks, and the replay defence.
 *
 * The load-bearing test in this file is **`refuses a replayed assertion`**, which is an acceptance
 * criterion stated almost word for word: it signs one real assertion and posts it twice, and the second
 * attempt is refused. It runs against a real migrated PostgreSQL because that is the only place the
 * guarantee actually lives — the unique index on `(organization_id, assertion_id)` is the mechanism, and
 * a mocked repository would happily accept both.
 *
 * The signature machinery itself is tested in `xml-signature.test.ts`, which also states plainly what
 * that kind of test can and cannot prove. This file is about what a signature does *not* establish: that
 * the assertion was issued to Compass, recently, and only once.
 */

const IDP_ENTITY_ID = 'https://idp.example.com/entity';
const SP_ENTITY_ID = 'https://compass.example.com/api/auth/saml/metadata';
const ACS_URL = 'https://compass.example.com/api/auth/saml/acs';

const at = (iso: string): Instant => instantFromIso(iso);
const NOW = at('2026-08-05T09:00:00Z');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERTIFICATE = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const DS = 'http://www.w3.org/2000/09/xmldsig#';
const SAML_A = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SAML_P = 'urn:oasis:names:tc:SAML:2.0:protocol';

interface ResponseOptions {
  readonly assertionId?: string;
  readonly issuer?: string;
  readonly audience?: string | null;
  readonly recipient?: string | null;
  readonly notBefore?: string | null;
  readonly notOnOrAfter?: string | null;
  readonly nameId?: string;
  readonly nameIdFormat?: string | null;
  readonly emailAttribute?: string | null;
  readonly displayName?: string | null;
  readonly statusCode?: string;
  readonly signed?: boolean;
  readonly encrypted?: boolean;
  readonly assertionCount?: number;
  readonly tamper?: (xml: string) => string;
}

/**
 * Builds a signed `SAMLResponse` the way an identity provider would.
 *
 * The signature is produced over this module's own canonical form, which is circular for the "a valid
 * assertion is accepted" case and is not for any other case here — every refusal below varies exactly
 * one thing about an otherwise-correct document, so what it proves is that *that* thing is caught.
 */
function samlResponse(options: ResponseOptions = {}): string {
  const assertionId = options.assertionId ?? '_assertion-1';
  const issuer = options.issuer ?? IDP_ENTITY_ID;
  const nameId = options.nameId ?? 'priya@example.com';
  const nameIdFormat =
    options.nameIdFormat === undefined
      ? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
      : options.nameIdFormat;

  const audience = options.audience === undefined ? SP_ENTITY_ID : options.audience;
  const recipient = options.recipient === undefined ? ACS_URL : options.recipient;
  const notBefore = options.notBefore === undefined ? '2026-08-05T08:55:00Z' : options.notBefore;
  const notOnOrAfter = options.notOnOrAfter === undefined ? '2026-08-05T09:10:00Z' : options.notOnOrAfter;

  const conditions =
    `<Conditions${notBefore === null ? '' : ` NotBefore="${notBefore}"`}` +
    `${notOnOrAfter === null ? '' : ` NotOnOrAfter="${notOnOrAfter}"`}>` +
    (audience === null
      ? ''
      : `<AudienceRestriction><Audience>${audience}</Audience></AudienceRestriction>`) +
    '</Conditions>';

  const attributes =
    options.emailAttribute === null && options.displayName === null
      ? ''
      : '<AttributeStatement>' +
        (options.emailAttribute === null
          ? ''
          : `<Attribute Name="email"><AttributeValue>${options.emailAttribute ?? 'priya@example.com'}</AttributeValue></Attribute>`) +
        (options.displayName === null
          ? ''
          : `<Attribute Name="displayName"><AttributeValue>${options.displayName ?? 'Priya Raman'}</AttributeValue></Attribute>`) +
        '</AttributeStatement>';

  const inner =
    `<Issuer>${issuer}</Issuer>` +
    `<Subject><NameID${nameIdFormat === null ? '' : ` Format="${nameIdFormat}"`}>${nameId}</NameID>` +
    `<SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<SubjectConfirmationData${recipient === null ? '' : ` Recipient="${recipient}"`}` +
    `${notOnOrAfter === null ? '' : ` NotOnOrAfter="${notOnOrAfter}"`}></SubjectConfirmationData>` +
    '</SubjectConfirmation></Subject>' +
    conditions +
    attributes;

  const buildAssertion = (id: string, signed: boolean): string => {
    const unsigned = `<Assertion xmlns="${SAML_A}" ID="${id}">${inner}</Assertion>`;
    if (!signed) return unsigned;

    const digest = createHash('sha256')
      .update(canonicalizeExclusive(parseXml(unsigned)), 'utf8')
      .digest('base64');

    const signedInfo =
      `<ds:SignedInfo xmlns:ds="${DS}">` +
      '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod>' +
      '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>' +
      `<ds:Reference URI="#${id}"><ds:Transforms>` +
      '<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform>' +
      '<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform>' +
      '</ds:Transforms>' +
      '<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>' +
      `<ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;

    const signer = createSign('RSA-SHA256');
    signer.update(canonicalizeExclusive(parseXml(signedInfo)), 'utf8');

    const signature =
      `<ds:Signature xmlns:ds="${DS}">${signedInfo}` +
      `<ds:SignatureValue>${signer.sign(privateKey, 'base64')}</ds:SignatureValue></ds:Signature>`;

    return `<Assertion xmlns="${SAML_A}" ID="${id}">${inner}${signature}</Assertion>`;
  };

  const count = options.assertionCount ?? 1;
  const assertions = Array.from({ length: count }, (_unused, index) =>
    buildAssertion(index === 0 ? assertionId : `${assertionId}-${index}`, options.signed !== false),
  ).join('');

  const xml =
    `<samlp:Response xmlns:samlp="${SAML_P}" ID="_response-1">` +
    `<samlp:Status><samlp:StatusCode Value="${options.statusCode ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"></samlp:StatusCode></samlp:Status>` +
    (options.encrypted === true ? `<EncryptedAssertion xmlns="${SAML_A}"></EncryptedAssertion>` : assertions) +
    '</samlp:Response>';

  return options.tamper ? options.tamper(xml) : xml;
}

const verify = (options: ResponseOptions = {}, now: Instant = NOW): SamlVerdict =>
  verifySamlResponse({
    xml: samlResponse(options),
    idpEntityId: IDP_ENTITY_ID,
    idpCertificate: CERTIFICATE,
    serviceProviderEntityId: SP_ENTITY_ID,
    assertionConsumerServiceUrl: ACS_URL,
    now,
  });

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('a correctly signed, audience-bound assertion', () => {
  it('is accepted, and yields the NameID as the subject', () => {
    const verdict = verify();

    expect(verdict.ok, verdict.ok ? '' : JSON.stringify(verdict.refusal)).toBe(true);
    if (!verdict.ok) return;

    expect(verdict.accepted.assertionId).toBe('_assertion-1');
    expect(verdict.accepted.issuer).toBe(IDP_ENTITY_ID);
    expect(verdict.accepted.assertion).toEqual({
      provider: 'saml',
      // The NameID, not the email attribute — a directory's NameID survives a rename.
      subject: 'priya@example.com',
      email: 'priya@example.com',
      // True because the organization's own IdP is the authority for its own namespace, which is what
      // lets SAML provision a seat where Google sign-in may not.
      emailVerified: true,
      displayName: 'Priya Raman',
    });
  });

  it('prefers the email attribute over the NameID when they differ', () => {
    const verdict = verify({ nameId: 'persistent-id-42', nameIdFormat: null, emailAttribute: 'p.raman@example.com' });

    expect(verdict.ok && verdict.accepted.assertion.email).toBe('p.raman@example.com');
    // The subject stays the opaque id, which is the whole point of a persistent NameID.
    expect(verdict.ok && verdict.accepted.assertion.subject).toBe('persistent-id-42');
  });

  it('takes the tighter of the two expiry windows for the replay ledger', () => {
    const verdict = verify({ notOnOrAfter: '2026-08-05T09:05:00Z' });

    expect(verdict.ok && verdict.accepted.notOnOrAfter).toBe(at('2026-08-05T09:05:00Z'));
  });
});

// ---------------------------------------------------------------------------
// What a signature does not establish
// ---------------------------------------------------------------------------

describe('the audience restriction, which stops a cross-service replay', () => {
  /**
   * The check most often missed, and the reason it matters.
   *
   * Without it, an assertion the IdP minted for a *different* service provider is accepted here — so
   * anybody who can sign into any application federated to the same IdP can present their assertion to
   * Compass and be signed in.
   */
  it('refuses an assertion issued for a different service provider', () => {
    const verdict = verify({ audience: 'https://some-other-app.example.com/saml' });

    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.refusal.kind).toBe('audience_mismatch');
  });

  it('refuses an assertion with no audience restriction at all', () => {
    // A missing restriction is not a permissive one: the IdP has not said this is for Compass.
    const verdict = verify({ audience: null });

    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.refusal.kind).toBe('audience_mismatch');
  });
});

describe('the issuer, the recipient and the window', () => {
  it('refuses an assertion from a different identity provider', () => {
    const verdict = verify({ issuer: 'https://attacker-idp.example.com/entity' });

    expect(!verdict.ok && verdict.refusal.kind).toBe('issuer_mismatch');
  });

  it('refuses an assertion addressed to a different sign-in URL', () => {
    const verdict = verify({ recipient: 'https://compass.evil.example/api/auth/saml/acs' });

    expect(!verdict.ok && verdict.refusal.kind).toBe('recipient_mismatch');
  });

  it('refuses an expired assertion', () => {
    const verdict = verify({}, at('2026-08-05T09:30:00Z'));

    expect(!verdict.ok && verdict.refusal.kind).toBe('expired');
  });

  it('refuses one that is not valid yet', () => {
    const verdict = verify({ notBefore: '2026-08-05T10:00:00Z', notOnOrAfter: '2026-08-05T11:00:00Z' });

    expect(!verdict.ok && verdict.refusal.kind).toBe('not_yet_valid');
  });

  it('tolerates a minute of clock skew in both directions, and no more', () => {
    // Sixty seconds either way is the smallest window that does not fail on ordinary clock drift.
    const justInsideSkew = instantFromIso(
      new Date(Date.parse('2026-08-05T09:10:00Z') + SAML_CLOCK_SKEW_MILLIS - 1000).toISOString(),
    );
    const pastSkew = instantFromIso(
      new Date(Date.parse('2026-08-05T09:10:00Z') + SAML_CLOCK_SKEW_MILLIS + 1000).toISOString(),
    );

    expect(verify({}, justInsideSkew).ok).toBe(true);
    expect(verify({}, pastSkew).ok).toBe(false);
  });
});

describe('what is refused outright rather than accommodated', () => {
  it('refuses an unsigned assertion', () => {
    const verdict = verify({ signed: false });

    expect(!verdict.ok && verdict.refusal.kind).toBe('signature');
  });

  it('refuses a tampered subject even though the signature is intact', () => {
    const verdict = verifySamlResponse({
      xml: samlResponse({ tamper: (xml) => xml.replace('priya@example.com', 'attacker@example.com') }),
      idpEntityId: IDP_ENTITY_ID,
      idpCertificate: CERTIFICATE,
      serviceProviderEntityId: SP_ENTITY_ID,
      assertionConsumerServiceUrl: ACS_URL,
      now: NOW,
    });

    expect(!verdict.ok && verdict.refusal.kind).toBe('signature');
    expect(!verdict.ok && verdict.refusal.kind === 'signature' && verdict.refusal.reason).toBe(
      'digest_mismatch',
    );
  });

  it('refuses an encrypted assertion rather than half-supporting it', () => {
    const verdict = verify({ encrypted: true });

    expect(!verdict.ok && verdict.refusal.kind).toBe('encrypted');
  });

  it('refuses a response carrying more than one assertion, which is ambiguous', () => {
    const verdict = verify({ assertionCount: 2 });

    expect(!verdict.ok && verdict.refusal.kind).toBe('malformed');
  });

  it('reports the identity provider’s own refusal as the provider’s, not as a config error', () => {
    const verdict = verify({ statusCode: 'urn:oasis:names:tc:SAML:2.0:status:AuthnFailed' });

    expect(!verdict.ok && verdict.refusal.kind).toBe('responder_error');
    // The sentence has to point at the provider, or an operator spends an afternoon in the wrong console.
    expect(!verdict.ok && describeSamlRefusal(verdict.refusal)).toMatch(/identity provider/i);
  });

  it('refuses an assertion with no email anywhere', () => {
    const verdict = verify({ nameId: 'opaque-42', nameIdFormat: null, emailAttribute: null });

    expect(!verdict.ok && verdict.refusal.kind).toBe('no_email');
  });

  it('refuses a document that is not a SAML Response at all', () => {
    const verdict = verifySamlResponse({
      xml: '<html><body>login page</body></html>',
      idpEntityId: IDP_ENTITY_ID,
      idpCertificate: CERTIFICATE,
      serviceProviderEntityId: SP_ENTITY_ID,
      assertionConsumerServiceUrl: ACS_URL,
      now: NOW,
    });

    expect(!verdict.ok && verdict.refusal.kind).toBe('malformed');
  });

  it('refuses a DOCTYPE, so an XXE payload never reaches the parser’s entity handling', () => {
    const verdict = verifySamlResponse({
      xml: '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>',
      idpEntityId: IDP_ENTITY_ID,
      idpCertificate: CERTIFICATE,
      serviceProviderEntityId: SP_ENTITY_ID,
      assertionConsumerServiceUrl: ACS_URL,
      now: NOW,
    });

    expect(!verdict.ok && verdict.refusal.kind).toBe('malformed');
  });

  it('gives every refusal a sentence an operator can act on', () => {
    const refusals = [
      verify({ signed: false }),
      verify({ audience: null }),
      verify({ issuer: 'other' }),
      verify({ encrypted: true }),
      verify({}, at('2026-08-05T10:00:00Z')),
    ];

    for (const verdict of refusals) {
      expect(verdict.ok).toBe(false);
      if (verdict.ok) continue;
      expect(describeSamlRefusal(verdict.refusal).length).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------------
// Replay — the acceptance criterion, against a real unique index
// ---------------------------------------------------------------------------

describe('a replayed assertion', () => {
  let harness: AuthHarness;

  beforeAll(async () => {
    harness = await createAuthHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  /**
   * The criterion, almost word for word: one real signed assertion, posted twice.
   *
   * Against a migrated PostgreSQL, because the guarantee *is* the unique index on
   * `(organization_id, assertion_id)` — acceptance is an INSERT, and its result is the verdict. A mocked
   * repository would accept both and this test would pass while the product was replayable.
   */
  it('verifies once and is refused the second time', async () => {
    const verdict = verify();
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const claim = () =>
      claimAssertionId(
        harness.scoped,
        {
          assertionId: verdict.accepted.assertionId,
          issuer: verdict.accepted.issuer,
          notOnOrAfter: verdict.accepted.notOnOrAfter,
        },
        NOW,
      );

    // The signature is just as valid the second time — which is exactly why the ledger has to exist.
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
  });

  it('refuses the replay even when the assertion is still inside its validity window', async () => {
    /**
     * The point worth stating: replay is not solved by expiry.
     *
     * A captured assertion is valid for its whole `NotOnOrAfter` window — minutes — and that is the
     * window an attacker replays inside. So the second attempt is refused while the assertion is still,
     * by every other measure, perfectly good.
     */
    const verdict = verify({ assertionId: '_within-window' });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const args = {
      assertionId: verdict.accepted.assertionId,
      issuer: verdict.accepted.issuer,
      notOnOrAfter: verdict.accepted.notOnOrAfter,
    };

    expect(await claimAssertionId(harness.scoped, args, NOW)).toBe(true);

    // One minute later, still well inside the window.
    const stillValid = at('2026-08-05T09:01:00Z');
    expect(verify({ assertionId: '_within-window' }, stillValid).ok).toBe(true);
    expect(await claimAssertionId(harness.scoped, args, stillValid)).toBe(false);
  });

  it('scopes the ledger to one organization, so two tenants may see the same id', async () => {
    // Not a hole: the assertion is bound to an audience and an issuer, so "the same id in two tenants"
    // means two genuinely different assertions from two different IdPs.
    const args = {
      assertionId: '_shared-id',
      issuer: IDP_ENTITY_ID,
      notOnOrAfter: at('2026-08-05T09:10:00Z'),
    };

    expect(await claimAssertionId(harness.scoped, args, NOW)).toBe(true);
    expect(await claimAssertionId(harness.other, args, NOW)).toBe(true);
    expect(await claimAssertionId(harness.scoped, args, NOW)).toBe(false);
  });

  it('resolves concurrent presentations of one assertion to exactly one winner', async () => {
    /**
     * The reason acceptance is an INSERT rather than a SELECT-then-INSERT.
     *
     * Two simultaneous posts of the same captured assertion would both pass a read-then-write check and
     * both mint a session. Here exactly one INSERT wins.
     */
    const args = {
      assertionId: '_raced',
      issuer: IDP_ENTITY_ID,
      notOnOrAfter: at('2026-08-05T09:10:00Z'),
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimAssertionId(harness.scoped, args, NOW)),
    );

    expect(results.filter((claimed) => claimed)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Provisioning, and the role ceiling
// ---------------------------------------------------------------------------

describe('SAML provisioning', () => {
  let harness: AuthHarness;

  beforeAll(async () => {
    harness = await createAuthHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('creates a seat with no password, at the configured role', async () => {
    const verdict = verify({ nameId: 'newjoiner@example.com', emailAttribute: 'newjoiner@example.com' });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const resolution = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: verdict.accepted.assertion,
      now: NOW,
      allowProvisioning: true,
      provisionRole: 'member',
    });

    expect(resolution.kind).toBe('signed_in');
    if (resolution.kind !== 'signed_in') return;

    expect(resolution.provisioned).toBe(true);
    expect(resolution.membership.role).toBe('member');
    expect(resolution.membership.status).toBe('active');
    /**
     * No password, and never a generated one.
     *
     * An invented password would be a credential nobody knows, which cannot be used and cannot be
     * revoked — and it would make the "this account signs in by link" branch of `verifyLogin` lie.
     */
    expect(resolution.user.passwordHash).toBeNull();
  });

  it('links to an existing seat rather than creating a second account', async () => {
    await ensureUser(harness.scoped, {
      email: 'existing@example.com',
      displayName: 'Existing Person',
      passwordHash: null,
      at: NOW,
    });
    const before = (await listSeats(harness.scoped)).length;

    const verdict = verify({ nameId: 'existing@example.com', emailAttribute: 'existing@example.com' });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    await ensureMembership(harness.scoped, {
      userId: userRowId(harness.scoped.organizationId, 'existing@example.com'),
      role: 'viewer',
      status: 'active',
      at: NOW,
    });

    const resolution = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: verdict.accepted.assertion,
      now: NOW,
      allowProvisioning: true,
      provisionRole: 'member',
    });

    expect(resolution.kind).toBe('signed_in');
    if (resolution.kind !== 'signed_in') return;

    expect(resolution.provisioned).toBe(false);
    // The existing role is kept: provisioning does not silently re-grade somebody.
    expect(resolution.membership.role).toBe('viewer');
    expect((await listSeats(harness.scoped)).length).toBeLessThanOrEqual(before + 1);
  });

  it('keeps the identity attached to the account it was first linked to', async () => {
    /**
     * The account-takeover primitive this closes.
     *
     * If a conflicting link could repoint `user_id`, anybody who could make an IdP assert an existing
     * subject could attach it to whichever account they liked. `linkIdentity` never updates `user_id`.
     */
    const verdict = verify({ nameId: 'stable@example.com', emailAttribute: 'stable@example.com' });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const first = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: verdict.accepted.assertion,
      now: NOW,
      allowProvisioning: true,
      provisionRole: 'member',
    });
    expect(first.kind).toBe('signed_in');

    // The same subject, now asserting somebody else's address.
    const second = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: { ...verdict.accepted.assertion, email: 'someone-else@example.com' },
      now: NOW,
      allowProvisioning: true,
      provisionRole: 'member',
    });

    expect(second.kind).toBe('signed_in');
    if (second.kind !== 'signed_in' || first.kind !== 'signed_in') return;

    expect(second.user.id).toBe(first.user.id);

    const identity = await findIdentityBySubject(harness.scoped, 'saml', 'stable@example.com');
    expect(identity?.userId).toBe(first.user.id);
  });

  /**
   * A revoked seat, and the asymmetry that decides whether it comes back.
   *
   * The two halves are deliberately different and the difference is the point:
   *
   *  - **A directory re-adding somebody is a decision to reinstate them.** Re-hires happen, and a SCIM
   *    or SAML client that could never re-add a person it had removed would leave an administrator with
   *    a seat they can see, cannot use and cannot repair. "Frees a seat" only means something if the
   *    seat can be filled again.
   *  - **Signing in with a consumer Google account is not that decision.** Somebody was deliberately
   *    taken off the product; their own provider account arriving at the door must not undo it, or
   *    `removeSeat` would be reversible by the person who was removed.
   *
   * This pair was originally a single test asserting the first case *also* refused, which was found by
   * a route test: a SCIM client re-adding a departed colleague got a 400 it could not act on.
   */
  it('lets a directory reinstate a revoked seat, at the role it held', async () => {
    const verdict = verify({ nameId: 'rehired@example.com', emailAttribute: 'rehired@example.com' });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const user = await ensureUser(harness.scoped, {
      email: 'rehired@example.com',
      displayName: 'Rehired Person',
      passwordHash: null,
      at: NOW,
    });
    await ensureMembership(harness.scoped, { userId: user.id, role: 'viewer', status: 'revoked', at: NOW });

    const resolution = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: verdict.accepted.assertion,
      now: NOW,
      allowProvisioning: true,
      provisionRole: 'member',
    });

    expect(resolution.kind).toBe('signed_in');
    expect((await findMembershipByUserId(harness.scoped, user.id))?.status).toBe('active');
    // The organization decided this person was a viewer. A re-add is not a re-grading, so the
    // provisioning default does not overwrite it.
    expect((await findMembershipByUserId(harness.scoped, user.id))?.role).toBe('viewer');
  });

  it('refuses a revoked seat for a sign-in that may not provision, and leaves it revoked', async () => {
    const user = await ensureUser(harness.scoped, {
      email: 'gone@example.com',
      displayName: 'Departed',
      passwordHash: null,
      at: NOW,
    });
    await ensureMembership(harness.scoped, { userId: user.id, role: 'member', status: 'revoked', at: NOW });

    const resolution = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: {
        provider: 'google',
        subject: 'google-departed',
        email: 'gone@example.com',
        emailVerified: true,
        displayName: 'Departed',
      },
      now: NOW,
      // No `allowProvisioning`: this is a consumer sign-in, not the organization's own directory.
    });

    expect(resolution).toEqual({ kind: 'refused', reason: 'seat_revoked' });
    expect((await findMembershipByUserId(harness.scoped, user.id))?.status).toBe('revoked');
  });

  it('activates a pending invitation, because a directory assertion is the proof one asks for', async () => {
    const verdict = verify({ nameId: 'invited@example.com', emailAttribute: 'invited@example.com' });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const user = await ensureUser(harness.scoped, {
      email: 'invited@example.com',
      displayName: 'Invited Person',
      passwordHash: null,
      at: NOW,
    });
    await ensureMembership(harness.scoped, { userId: user.id, role: 'manager', status: 'pending', at: NOW });

    const resolution = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: verdict.accepted.assertion,
      now: NOW,
      allowProvisioning: true,
      provisionRole: 'member',
    });

    expect(resolution.kind).toBe('signed_in');
    if (resolution.kind !== 'signed_in') return;

    expect(resolution.seatActivated).toBe(true);
    expect(resolution.membership.status).toBe('active');
    // And the invited role is honoured, not overwritten by the provisioning default.
    expect(resolution.membership.role).toBe('manager');
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('service-provider metadata', () => {
  const metadata = samlServiceProviderMetadata({
    entityId: SP_ENTITY_ID,
    assertionConsumerServiceUrl: ACS_URL,
  });

  it('states the entity id and the ACS URL the routes actually enforce', () => {
    expect(metadata).toContain(`entityID="${SP_ENTITY_ID}"`);
    expect(metadata).toContain(`Location="${ACS_URL}"`);
    expect(metadata).toContain('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
  });

  it('declares that assertions must be signed, which is the requirement Compass enforces', () => {
    // The document and the verifier have to agree, or an operator configures the wrong thing and the
    // failure appears at a check they cannot see.
    expect(metadata).toContain('WantAssertionsSigned="true"');
  });

  it('is honest that Compass does not sign its own requests', () => {
    expect(metadata).toContain('AuthnRequestsSigned="false"');
  });

  it('is parseable by the reader that verifies assertions, so it is well-formed XML', () => {
    expect(() => parseXml(metadata.replace(/<\?xml[^>]*\?>\n?/, ''))).not.toThrow();
  });
});
