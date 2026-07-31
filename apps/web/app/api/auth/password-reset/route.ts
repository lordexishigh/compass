import { requestPasswordReset } from '@compass/auth';
import type { NextResponse } from 'next/server';

import { baseUrlFor, guard, mailer, organizationName } from '../../../../lib/auth/guard';
import { failure, jsonOk, readJsonObject, requiredString } from '../../../../lib/auth/http';

/**
 * `POST /api/auth/password-reset` — mails a 1-hour, single-use reset link.
 *
 * Like the magic link, the answer is the same for an address with a seat and one
 * without: a reset form that said "no such user" would be a membership oracle.
 *
 * Issuing a link revokes any earlier unused one, so asking twice does not leave two
 * live links — the newest is the only one that works.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/password-reset', action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const email = requiredString(parsed.body, 'email');
  if ('response' in email) return email.response;

  try {
    const result = await requestPasswordReset({
      scoped: admitted.scoped,
      email: email.value,
      now: admitted.now,
      mailer: mailer(),
      organizationName: await organizationName(admitted.scoped),
      baseUrl: baseUrlFor(request),
    });

    return jsonOk({ requested: true, detail: result.stated });
  } catch (error) {
    return failure(error);
  }
}
