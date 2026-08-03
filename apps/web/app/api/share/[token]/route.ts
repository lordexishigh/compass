import { randomUUID } from 'node:crypto';

import {
  findShareLinkByTokenHash,
  loadReportBundle,
  recordShareLinkAccess,
  type ScopedDb,
  type ShareAccessOutcome,
} from '@compass/db';
import { SHARE_LINK_STATUS, hashShareToken, ipPrefixOf, shareLinkVerdict } from '@compass/delivery';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk } from '../../../../lib/auth/http';
import { checkRateLimit } from '../../../../lib/rate-limit';

/**
 * `GET /api/share/<token>` — a shared report permalink.
 *
 * ## Every outcome is logged, including the ones that refuse
 *
 * The access row is written before the response is returned, on all five paths — served, expired,
 * revoked, forbidden and not_found. Recording only successes would make the table useless for the
 * question it exists to answer: "somebody tried a revoked link forty times last night" is exactly
 * the fact an operator needs, and a log of successes cannot state it.
 *
 * ## Org members only by default
 *
 * A token being hard to guess is not an authorization decision. `shareLinkVerdict` refuses an
 * anonymous reader unless the link was explicitly made public, so the default posture is that a
 * leaked URL still does not hand a stranger the organization's blockers and risks.
 *
 * ## 410 versus 404
 *
 * A revoked or expired link answers 410 — it existed and is finished, which is a more useful thing
 * to tell a colleague than "no such link". A token matching nothing answers 404 and says nothing
 * more, so the route does not confirm which tokens could have been valid.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/share/[token]';

/** The client's network and agent, reduced to what the log should keep. */
const requestFacts = (request: Request) => ({
  ipPrefix: ipPrefixOf(request.headers.get('x-forwarded-for')),
  userAgent: request.headers.get('user-agent'),
});

/** One place that writes the row, so no path can return without logging. */
async function logAccess(
  scoped: ScopedDb,
  input: {
    readonly shareLinkId: string | null;
    readonly outcome: ShareAccessOutcome;
    readonly request: Request;
    readonly userId: string | null;
  },
  at: Parameters<typeof recordShareLinkAccess>[2],
): Promise<void> {
  const facts = requestFacts(input.request);
  await recordShareLinkAccess(
    scoped,
    {
      id: randomUUID(),
      shareLinkId: input.shareLinkId,
      outcome: input.outcome,
      ipPrefix: facts.ipPrefix,
      userAgent: facts.userAgent,
      userId: input.userId,
    },
    at,
  );
}

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly token: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  const { token } = await context.params;
  const userId = admitted.identity?.user.id ?? null;

  /**
   * 120 reads per minute, counted against the *token*.
   *
   * Per token rather than per IP, and that is the whole design of this one. A share link is the
   * only credential Compass hands out that may legitimately be opened by many people from many
   * networks — a link pasted into a channel gets fetched by every unfurling bot in the workspace —
   * so a per-IP limit here would be no limit at all. Per token bounds what a *leaked* link is
   * worth: it stays openable by the colleagues it was meant for and stops being a free API onto
   * the organization's reports.
   *
   * Counted on the hashed token, so the limiter's own key space holds no bearer secret. And
   * counted before the lookup, so a flood of guesses at nonexistent tokens costs one Map read
   * rather than one query each.
   */
  const limited = checkRateLimit({
    action: 'share_link_read',
    subjects: { token: hashShareToken(token) },
    now: admitted.now,
  });
  if (!limited.allowed && limited.response !== null) return limited.response;

  try {
    // Looked up by digest: the token in the URL is never compared against a stored secret, and the
    // secret itself was shown once when the link was created.
    const link = await findShareLinkByTokenHash(admitted.scoped, hashShareToken(token));

    if (link === null) {
      await logAccess(
        admitted.scoped,
        { shareLinkId: null, outcome: 'not_found', request, userId },
        admitted.now,
      );
      return jsonError(
        'share_link_not_found',
        'No share link matches this address. It may have been deleted, or the address may be mistyped.',
        SHARE_LINK_STATUS.not_found,
      );
    }

    const verdict = shareLinkVerdict(
      { revokedAt: link.revokedAt, expiresAt: link.expiresAt, audience: link.audience },
      { now: admitted.now, signedIn: userId !== null },
    );

    await logAccess(
      admitted.scoped,
      { shareLinkId: link.id, outcome: verdict, request, userId },
      admitted.now,
    );

    if (verdict !== 'served') {
      return jsonError(`share_link_${verdict}`, REFUSAL_DETAIL[verdict], SHARE_LINK_STATUS[verdict]);
    }

    const bundle = await loadReportBundle(admitted.scoped, link.reportId);
    if (bundle === null) {
      // The link is valid and the report it names is gone. Stated rather than served as an empty
      // document, which would read as a report with nothing in it.
      return jsonError(
        'share_link_report_missing',
        'This link is valid but the report it points at is no longer stored.',
        410,
      );
    }

    return jsonOk({
      reportId: bundle.report.id,
      reportDate: bundle.report.reportDate,
      scopeKind: bundle.report.scopeKind,
      scopeKey: bundle.report.scopeKey,
      prose: bundle.report.prose,
      sections: bundle.sections.map((section) => ({
        key: section.sectionKey,
        ordinal: section.ordinal,
        title: section.title,
        prose: section.prose,
        itemCount: section.itemCount,
      })),
    });
  } catch (error) {
    return failure(error);
  }
}

/** One sentence per refusal, each naming what would change it. */
const REFUSAL_DETAIL: Readonly<Record<Exclude<ShareAccessOutcome, 'served'>, string>> = {
  revoked: 'This share link was revoked, so it no longer opens the report. Ask whoever shared it for a new one.',
  expired: 'This share link has expired. Ask whoever shared it for a new one.',
  forbidden:
    'This report is shared with members of the organization only. Sign in to read it, or ask for a link that is ' +
    'shared more widely.',
  not_found: 'No share link matches this address.',
};
