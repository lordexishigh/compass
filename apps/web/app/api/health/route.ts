import { NextResponse } from 'next/server';

import { readiness } from '../../../lib/health';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — readiness, stated rather than implied.
 *
 * Always 200 with a body that names each capability and its condition; a
 * missing integration is a documented state, not an error page. Only an
 * unexpected fault produces 503.
 */
export async function GET(): Promise<NextResponse> {
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
