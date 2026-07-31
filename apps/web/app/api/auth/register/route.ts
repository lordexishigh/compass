import { hasOwner, registerAccount, startSession } from '@compass/auth';
import { NextResponse } from 'next/server';

import { setSessionCookie } from '../../../../lib/auth/cookies';
import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, readJsonObject, requiredPassword, requiredString } from '../../../../lib/auth/http';

/**
 * `POST /api/auth/register` — the first account, and only the first.
 *
 * Compass is invite-only: after an organization has an owner, a seat comes from
 * `POST /api/seats` and nothing else. Open registration would mean anyone who found
 * the URL could give themselves a seat in somebody else's organization.
 *
 * So this route closes itself. While the organization has no owner it creates one and
 * signs them in; once it has one it answers 409 and says where to go instead. The boot
 * script normally gets there first — `bootstrapOwner` runs on every container start —
 * so in practice this is the path for a deployment that has cleared its owner, and the
 * reason a database with no owner is never a locked door.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/register', action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const email = requiredString(parsed.body, 'email');
  if ('response' in email) return email.response;
  const displayName = requiredString(parsed.body, 'displayName');
  if ('response' in displayName) return displayName.response;
  const password = requiredPassword(parsed.body);
  if ('response' in password) return password.response;

  try {
    if (await hasOwner(admitted.scoped)) {
      return jsonError(
        'registration_closed',
        'This organization already has an owner, so seats are created by invitation. Ask an owner to invite you — ' +
          'they can do it from the seats screen — or sign in if you already have a seat.',
        409,
      );
    }

    const registered = await registerAccount({
      scoped: admitted.scoped,
      email: email.value,
      displayName: displayName.value,
      password: password.value,
      role: 'owner',
      status: 'active',
      now: admitted.now,
    });

    const started = await startSession({
      scoped: admitted.scoped,
      userId: registered.user.id,
      now: admitted.now,
    });

    const response = NextResponse.json(
      {
        signedIn: true,
        email: registered.user.email,
        displayName: registered.user.displayName,
        role: registered.membership.role,
        detail: 'You are the owner of this organization. Every other seat is created by invitation from here on.',
      },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );

    return setSessionCookie(response, request, started.secret);
  } catch (error) {
    return failure(error);
  }
}
