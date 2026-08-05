import { isSsoProvider, recordAudit, verifyPassword } from '@compass/auth';
import { listIdentitiesForUser, unlinkIdentity } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../../lib/auth/guard';
import {
  failure,
  isFormSubmission,
  jsonError,
  jsonOk,
  readFormOrJsonObject,
  requiredString,
  seeOtherPath,
} from '../../../../../lib/auth/http';

/**
 * `POST /api/auth/sso/unlink` — removes one provider link from your own account.
 *
 * ## Why this needs the password, and why that is not friction for its own sake
 *
 * Unlinking is not obviously dangerous, so the reflex is to allow it on a session alone. The reason it
 * demands re-authentication is the *other* direction: for an account whose only credential is the
 * provider link, unlinking is a lockout — and a stolen session that could unlink every provider would
 * be a denial-of-service against the account holder that they could not undo, because the way back in
 * is the thing that was just removed.
 *
 * So it costs the same proof turning off the second factor does. An account with no password at all —
 * one provisioned by SAML, or created by an emailed link — is refused with a sentence saying to set a
 * password first, which is honest: there is no credential to re-authenticate with.
 *
 * ## The last credential is not removable
 *
 * Refused when the link being removed is the only way the account can sign in. Compass would otherwise
 * cheerfully lock somebody out of their own seat on one click, and the owner-recovery path for that is
 * an emailed reset link — which only works if the mailer is configured. Refusing is recoverable; a
 * lockout may not be.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/auth/sso/unlink';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;
  if (admitted.identity === null) return jsonError('forbidden', 'This needs a seat.', 403);

  const user = admitted.identity.user;
  const browserForm = isFormSubmission(request);

  const parsed = await readFormOrJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const provider = requiredString(parsed.body, 'provider');
  if ('response' in provider) return provider.response;
  const password = requiredString(parsed.body, 'password');
  if ('response' in password) return password.response;

  if (!isSsoProvider(provider.value)) {
    return jsonError('unknown_provider', 'Compass signs in with Google and GitHub. That is neither.', 400);
  }

  try {
    if (user.passwordHash === null) {
      return jsonError(
        'no_password_set',
        'This account has no password, so there is nothing to re-authenticate with — and unlinking the ' +
          'provider would lock you out. Set a password from the reset form first, then unlink.',
        409,
      );
    }

    if (!(await verifyPassword(user.passwordHash, password.value))) {
      return jsonError(
        'reauthentication_failed',
        'Enter your current password to unlink a sign-in provider. This is asked even though you are ' +
          'signed in, because an unattended browser must not be able to remove your way back in.',
        403,
      );
    }

    const identities = await listIdentitiesForUser(admitted.scoped, user.id);
    const linked = identities.find((identity) => identity.provider === provider.value);

    if (linked === undefined) {
      return browserForm
        ? seeOtherPath(request, '/account?sso=not-linked')
        : jsonError('not_linked', 'That provider is not linked to this account.', 409);
    }

    const removed = await unlinkIdentity(admitted.scoped, { userId: user.id, provider: provider.value });

    // `false` means another request removed it first. Reported as done rather than as a conflict: the
    // caller asked for it to be gone and it is gone.
    if (removed) {
      await recordAudit(admitted.scoped, {
        action: 'account.identity_unlinked',
        actorUserId: user.id,
        targetKind: 'user',
        targetId: user.id,
        before: { provider: provider.value, linked: true, subject: linked.subject },
        after: { provider: provider.value, linked: false },
        occurredAt: admitted.now,
      });
    }

    return browserForm
      ? seeOtherPath(request, '/account?sso=unlinked')
      : jsonOk({
          provider: provider.value,
          linked: false,
          detail: 'That provider is no longer linked to your account. This is on your account’s record.',
        });
  } catch (error) {
    return failure(error);
  }
}
