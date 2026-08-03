import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { completeLogin } from '../../../../lib/auth/login';

/**
 * `POST /api/auth/login` — email and password in, session cookie out.
 *
 * On success this answers 200 and sets an `httpOnly; Secure; SameSite=Lax` cookie
 * whose value is a fresh 256-bit secret. Only the SHA-256 of that secret reaches the
 * database, so the row cannot be turned back into a working session.
 *
 * A wrong address and a wrong password produce the same 401 and the same sentence:
 * distinguishing them would publish which addresses have accounts here. The
 * unknown-address branch still performs one Argon2id verification against a decoy
 * hash, so the *timing* does not publish it either.
 *
 * The body of it lives in `lib/auth/login.ts`, shared with `/login` — the short address
 * `.nous/demo_account.json` publishes for a verification harness. Two routes accept these
 * credentials and they must be the same sign-in; the guard call stays here, per route,
 * because that is the decision which has to be visible at every handler.
 */
export const dynamic = 'force-dynamic';
// Argon2id is a native addon. It cannot load on the Edge runtime, and a route that
// hashed a password there would fail at build time rather than at request time.
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/login', action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  return completeLogin(request, admitted);
}
