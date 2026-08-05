import {
  composeScimTokenMail,
  generateScimToken,
  hashScimToken,
  isSeatRole,
  recordAudit,
} from '@compass/auth';
import { ENTERPRISE_IDENTITY_REQUIRED_STATEMENT } from '@compass/billing';
import {
  disableSamlConnection,
  findSamlConnection,
  insertScimCredential,
  listScimCredentials,
  revokeScimCredential,
  saveSamlConnection,
} from '@compass/db';
import type { NextResponse } from 'next/server';

import { baseUrlFor, guard, mailer, organizationName } from '../../../../lib/auth/guard';
import {
  failure,
  isFormSubmission,
  jsonError,
  jsonOk,
  readFormOrJsonObject,
  requiredString,
  seeOtherPath,
} from '../../../../lib/auth/http';
import { certificateFingerprint, enterpriseIdentityAllowed } from '../../../../lib/sso-source';

/**
 * `/api/enterprise/identity` — an owner configures SAML and issues SCIM tokens.
 *
 * ## Owner only, and not a manager
 *
 * Same judgement `/api/billing/*` makes and for a sharper reason: configuring an IdP decides *who can
 * become a member of this organization*. A manager who could point Compass at a directory they control
 * could provision themselves an owner-adjacent seat — the role ceiling in the schema stops the worst of
 * it, but the decision is plainly the owner's.
 *
 * ## Three acts on one route
 *
 * They are one resource — this organization's enterprise identity configuration — in three states, and
 * splitting them would produce three matrix rows and three places to get the plan gate right for one
 * noun. `POST` saves the SAML connection or issues a SCIM token, distinguished by the `intent` field;
 * `DELETE` disables SAML or revokes a token.
 *
 * ## The token is mailed, never returned
 *
 * `POST intent=scim_token` mints a token and sends it to the owner who asked for it. It is deliberately
 * **not** in the response body: `compass/no-secret-disclosure` refuses a credential in any response and
 * the quality gate asserts that no file anywhere disables that rule. `issueToken` records the full
 * reasoning, including why the obvious exception argument is weaker than it looks.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/enterprise/identity';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;
  if (admitted.identity === null) return jsonError('forbidden', 'This needs a seat.', 403);

  const browserForm = isFormSubmission(request);
  const parsed = await readFormOrJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const intent = requiredString(parsed.body, 'intent');
  if ('response' in intent) return intent.response;

  try {
    // The plan gate, before anything is written. Read from the plan table, never a name comparison.
    if (!(await enterpriseIdentityAllowed(admitted.scoped))) {
      return browserForm
        ? seeOtherPath(request, '/enterprise?identity=plan-required')
        : jsonError('plan_required', ENTERPRISE_IDENTITY_REQUIRED_STATEMENT, 402);
    }

    if (intent.value === 'saml') return await saveSaml(request, admitted, parsed.body, browserForm);
    if (intent.value === 'scim_token') return await issueToken(request, admitted, parsed.body, browserForm);

    /**
     * The two withdrawals are reachable on `POST` as well as on `DELETE`, and that is not laziness.
     *
     * An HTML form can only issue `GET` or `POST`. The alternatives were a hidden `_method` field the
     * route decodes — a method override, which is a small piece of framework nobody else in this product
     * has — or client JavaScript on the one screen an administrator uses while reading another console.
     * A named intent is neither: it is the same shape the two *creating* acts already use, so the form
     * posts and the route reads one field.
     *
     * `DELETE` stays available for API callers, and both spellings run the same function.
     */
    if (intent.value === 'saml_disable') return await disableSaml(request, admitted, browserForm);
    if (intent.value === 'scim_token_revoke') {
      return await revokeToken(request, admitted, parsed.body, browserForm);
    }

    return jsonError(
      'unknown_intent',
      'The `intent` must be `saml` or `scim_token` to configure, or `saml_disable` or ' +
        '`scim_token_revoke` to withdraw.',
      400,
    );
  } catch (error) {
    return failure(error);
  }
}

async function saveSaml(
  request: Request,
  admitted: Extract<Awaited<ReturnType<typeof guard>>, { allowed: true }>,
  body: Record<string, unknown>,
  browserForm: boolean,
): Promise<NextResponse> {
  const entityId = requiredString(body, 'idpEntityId');
  if ('response' in entityId) return entityId.response;
  const ssoUrl = requiredString(body, 'idpSsoUrl');
  if ('response' in ssoUrl) return ssoUrl.response;
  const certificate = requiredString(body, 'idpCertificate');
  if ('response' in certificate) return certificate.response;

  const roleValue = typeof body['defaultRole'] === 'string' ? body['defaultRole'].trim() : 'member';

  /**
   * `owner` is refused here as well as in the database.
   *
   * The check constraint is the guarantee; this is the *sentence*. A constraint violation surfaces as a
   * 500 with a driver message, and an owner who tried to set it deserves to be told why it is refused
   * rather than shown a stack trace.
   */
  if (!isSeatRole(roleValue) || roleValue === 'owner') {
    return jsonError(
      'invalid_role',
      'A seat created by an identity provider may be a manager, a member or a viewer — never an owner. ' +
        'Otherwise anybody who can add a user to a directory group could take over this organization.',
      400,
    );
  }

  /**
   * The sign-in URL must be `https`, and that is not pedantry.
   *
   * It is the address people are sent to type a corporate password into. An `http` URL here would be a
   * credential-harvesting redirect that Compass itself published.
   */
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(ssoUrl.value);
  } catch {
    return jsonError('invalid_sso_url', 'The identity provider’s sign-in URL is not a valid URL.', 400);
  }
  if (parsedUrl.protocol !== 'https:') {
    return jsonError(
      'invalid_sso_url',
      'The identity provider’s sign-in URL must be https. That is the address people type a corporate ' +
        'password into, so Compass will not store an unencrypted one.',
      400,
    );
  }

  // Base64 DER, with any PEM armour and whitespace removed — the form IdP metadata uses.
  const cleaned = certificate.value.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (cleaned.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    return jsonError(
      'invalid_certificate',
      'That does not look like a certificate. Paste the X.509 signing certificate from your identity ' +
        'provider’s metadata — base64, with or without the BEGIN/END lines.',
      400,
    );
  }

  const before = await findSamlConnection(admitted.scoped);

  const saved = await saveSamlConnection(
    admitted.scoped,
    {
      idpEntityId: entityId.value,
      idpSsoUrl: ssoUrl.value,
      idpCertificate: cleaned,
      defaultRole: roleValue,
    },
    admitted.now,
  );

  await recordAudit(admitted.scoped, {
    action: 'config.enterprise_identity_changed',
    actorUserId: admitted.identity?.user.id ?? null,
    targetKind: 'organization',
    targetId: admitted.organizationId,
    /**
     * Fingerprints, never certificates.
     *
     * The certificate is public so this is not secrecy — it is legibility. An audit row holding 1,400
     * base64 characters is a row nobody reads, and the question a reader has is "did the certificate
     * change", which 40 hex characters answers.
     */
    before:
      before === null
        ? { saml: 'unconfigured' }
        : {
            saml: 'configured',
            idpEntityId: before.idpEntityId,
            certificateFingerprint: await certificateFingerprint(before.idpCertificate),
            defaultRole: before.defaultRole,
          },
    after: {
      saml: 'configured',
      idpEntityId: saved.idpEntityId,
      certificateFingerprint: await certificateFingerprint(saved.idpCertificate),
      defaultRole: saved.defaultRole,
    },
    occurredAt: admitted.now,
  });

  return browserForm
    ? seeOtherPath(request, '/enterprise?identity=saml-saved')
    : jsonOk({
        saml: { configured: true, idpEntityId: saved.idpEntityId, defaultRole: saved.defaultRole },
        detail: 'SAML single sign-on is configured and enabled. This change is on the organization’s record.',
      });
}

/**
 * Issues a provisioning token and **mails** it to the owner who asked for it.
 *
 * ## Why it is not in this response
 *
 * The first version of this handler returned the token in its body, under a field named `bearerToken`,
 * with a comment arguing that a bearer credential which is never returned cannot be used.
 * `compass/no-secret-disclosure` refused it — and `tools/quality-gates/tests/security-posture.test.ts`
 * additionally asserts that **no file anywhere disables that rule**, precisely so the next person cannot
 * decide their case is the exception.
 *
 * The gate is right, and the argument for the exception was weaker than it looked. A token in a response
 * body sits in the browser's memory, in any proxy that terminated TLS, and in whatever console the
 * operator had open — and *this* token can create and remove seats. Worse, the screen that would display
 * it is the screen an administrator is most likely to be screen-sharing, because configuring an IdP is
 * usually done on a call with somebody from IT.
 *
 * So it goes by mail, which is the channel this product already uses to deliver a one-time secret — a
 * magic link and a reset link are both credentials in an inbox. The response says only that it was sent,
 * and to where.
 */
async function issueToken(
  request: Request,
  admitted: Extract<Awaited<ReturnType<typeof guard>>, { allowed: true }>,
  body: Record<string, unknown>,
  browserForm: boolean,
): Promise<NextResponse> {
  const label = typeof body['label'] === 'string' && body['label'].trim().length > 0
    ? body['label'].trim()
    : 'SCIM provisioning';

  const recipient = admitted.identity?.user.email ?? null;

  /**
   * Refused when there is nobody to send it to, rather than falling back to the response body.
   *
   * The matrix already guarantees an owner reached this route, so this is the type-checker's branch more
   * than a real one — but a credential minted with no delivery path would be a row in the database that
   * nobody can ever use, which is worse than a refusal.
   */
  if (recipient === null) {
    return jsonError('forbidden', 'A provisioning token is mailed to the owner who issues it.', 403);
  }

  const before = (await listScimCredentials(admitted.scoped)).length;
  const token = generateScimToken();

  await insertScimCredential(admitted.scoped, { tokenHash: hashScimToken(token), label }, admitted.now);

  await mailer().send(
    composeScimTokenMail({
      to: recipient,
      organizationName: await organizationName(admitted.scoped),
      label,
      token,
      scimUrl: `${baseUrlFor(request)}/api/scim/v2/Users`,
      link: `${baseUrlFor(request)}/enterprise`,
    }),
  );

  await recordAudit(admitted.scoped, {
    action: 'config.enterprise_identity_changed',
    actorUserId: admitted.identity?.user.id ?? null,
    targetKind: 'organization',
    targetId: admitted.organizationId,
    before: { scimCredentials: before },
    // The label and the count, never the token and never its digest. The digest is not itself a secret,
    // but a hash in a browsable table is one more place a credential-shaped string lives for no
    // reader's benefit.
    after: { scimCredentials: before + 1, label },
    occurredAt: admitted.now,
  });

  return browserForm
    ? seeOtherPath(request, '/enterprise?identity=token-issued')
    : jsonOk({
        label,
        // Where it went, and never the value. A masked token would still confirm its length and prefix.
        mailedTo: recipient,
        detail:
          'The provisioning token has been emailed to you. It is not shown here and cannot be recovered — ' +
          'only a SHA-256 of it is stored. Revoke it from this screen if it is ever exposed.',
      });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'DELETE' });
  if (!admitted.allowed) return admitted.response;

  const browserForm = isFormSubmission(request);
  const parsed = await readFormOrJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const intent = requiredString(parsed.body, 'intent');
  if ('response' in intent) return intent.response;

  try {
    /**
     * No plan gate on a withdrawal, and that is deliberate.
     *
     * An organization that has *downgraded* must still be able to revoke a SCIM token it issued while on
     * the Business plan. Gating the removal behind the plan that permitted the creation would strand a
     * live provisioning credential with no way to withdraw it — the exact opposite of what the gate is
     * for.
     */
    if (intent.value === 'saml' || intent.value === 'saml_disable') {
      return await disableSaml(request, admitted, browserForm);
    }
    if (intent.value === 'scim_token' || intent.value === 'scim_token_revoke') {
      return await revokeToken(request, admitted, parsed.body, browserForm);
    }

    return jsonError(
      'unknown_intent',
      'The `intent` must be `saml` to turn SAML off, or `scim_token` to revoke a provisioning token.',
      400,
    );
  } catch (error) {
    return failure(error);
  }
}

/** Turns SAML off, keeping the certificate so it stays auditable. */
async function disableSaml(
  request: Request,
  admitted: Extract<Awaited<ReturnType<typeof guard>>, { allowed: true }>,
  browserForm: boolean,
): Promise<NextResponse> {
  const disabled = await disableSamlConnection(admitted.scoped, admitted.now);

  if (disabled) {
    await recordAudit(admitted.scoped, {
      action: 'config.enterprise_identity_changed',
      actorUserId: admitted.identity?.user.id ?? null,
      targetKind: 'organization',
      targetId: admitted.organizationId,
      before: { saml: 'enabled' },
      after: { saml: 'disabled' },
      occurredAt: admitted.now,
    });
  }

  return browserForm
    ? seeOtherPath(request, '/enterprise?identity=saml-disabled')
    : jsonOk({
        saml: { enabled: false },
        detail:
          'SAML single sign-on is off. The certificate is kept so it stays auditable, and nobody can ' +
          'sign in through the identity provider until it is enabled again.',
      });
}

/** Revokes one provisioning token. Idempotent: an already-revoked token is not an error. */
async function revokeToken(
  request: Request,
  admitted: Extract<Awaited<ReturnType<typeof guard>>, { allowed: true }>,
  body: Record<string, unknown>,
  browserForm: boolean,
): Promise<NextResponse> {
  const credentialId = requiredString(body, 'credentialId');
  if ('response' in credentialId) return credentialId.response;

  const revoked = await revokeScimCredential(admitted.scoped, credentialId.value, admitted.now);

  if (revoked) {
    await recordAudit(admitted.scoped, {
      action: 'config.enterprise_identity_changed',
      actorUserId: admitted.identity?.user.id ?? null,
      targetKind: 'organization',
      targetId: admitted.organizationId,
      // Named for the *row* rather than for the credential: `compass/no-credential-literal` reads a
      // property called `scimToken` as a compiled-in secret, and it is right to — the field describes
      // the credential's state, so that is what it is called.
      before: { scimCredential: 'live', credentialId: credentialId.value },
      after: { scimCredential: 'revoked', credentialId: credentialId.value },
      occurredAt: admitted.now,
    });
  }

  return browserForm
    ? seeOtherPath(request, `/enterprise?identity=${revoked ? 'token-revoked' : 'token-unknown'}`)
    : jsonOk({
        revoked,
        detail: revoked
          ? 'That provisioning token no longer works. Any SCIM client using it will start getting 401s.'
          : 'That token was already revoked, or it does not belong to this organization.',
      });
}
