import { requestMagicLink } from '@compass/auth';
import type { NextResponse } from 'next/server';

import { baseUrlFor, guard, mailer, organizationName } from '../../../../lib/auth/guard';
import { failure, jsonOk, readJsonObject, requiredString } from '../../../../lib/auth/http';

/**
 * `POST /api/auth/magic-link` — mails a 15-minute, single-use sign-in link.
 *
 * The response is the same whether or not the address has a seat here. Telling the
 * caller "no such user" would turn this form into a way to read the organization's
 * membership list, so the sentence is conditional — *if* that address has a seat — and
 * the same sentence is returned either way.
 *
 * Issuing a link revokes any earlier unused one, so a forwarded older mail stops
 * working the moment a new one is requested.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/magic-link', action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const email = requiredString(parsed.body, 'email');
  if ('response' in email) return email.response;

  try {
    const result = await requestMagicLink({
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
