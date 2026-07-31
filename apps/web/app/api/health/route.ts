import { NextResponse } from 'next/server';

import { guard } from '../../../lib/auth/guard';
import { readiness } from '../../../lib/health';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/health — readiness, stated rather than implied.
 *
 * Always 200 with a body that names each capability and its condition; a
 * missing integration is a documented state, not an error page. Only an
 * unexpected fault produces 503.
 *
 * Public for every principal, including `public`, and unlike `/` it is public in a real
 * tenant too: the container's own `HEALTHCHECK` calls it with no cookie, and it carries
 * no organizational data — capability names and conditions only. It still goes through
 * `guard`, because the route-coverage test requires every route to have a matrix entry
 * and an unguarded route would be one the matrix could not describe.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/health', action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  try {
    const report = await readiness();
    return NextResponse.json(report, {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'degraded',
        checks: [
          {
            name: 'readiness',
            status: 'degraded',
            detail: error instanceof Error ? error.message : 'Readiness could not be computed.',
          },
        ],
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
