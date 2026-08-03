import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  JIRA_AUTHORIZATION_HEADER,
  JIRA_SIGNATURE_HEADER,
  WEBHOOK_PROVIDERS,
  WEBHOOK_SECRET_ENV_VAR,
  describeWebhookVerdict,
  isWebhookAccepted,
  isWebhookProvider,
  slackWebhookVerdict,
  verifyGithubSignature,
  verifyJiraSignature,
  type WebhookProvider,
  type WebhookVerdict,
} from '@compass/auth';
import {
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  verifySlackSignature,
} from '@compass/delivery';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { jsonError, jsonOk } from '../../../../lib/auth/http';

/**
 * `POST /api/webhooks/<provider>` — the one door a source provider knocks on.
 *
 * One route for all three providers rather than three routes, because the *decision* is
 * identical in all three cases and only the arithmetic differs. Three routes would be three
 * places to forget to log a refusal, and three matrix entries where one states the posture.
 *
 * ## Verified before anything else happens
 *
 * The body is read as text and never parsed before verification. All three schemes sign the raw
 * bytes, so a handler that parsed JSON and re-serialised would hash something the provider never
 * sent — and every legitimate delivery would fail while whoever was debugging it concluded the
 * secret was wrong.
 *
 * ## Why a refusal is 401 and not 403
 *
 * The request failed to *authenticate*: it did not prove it came from the provider. 403 would say
 * "we know who you are and you may not do this", which is a different and less accurate statement.
 * The body says only that the signature did not verify — the specific verdict (`bad_signature`,
 * `stale_timestamp`, `unconfigured`) goes to the log and not to the caller, because telling an
 * unauthenticated caller *which* check they failed is a tuning signal.
 *
 * ## What a verified delivery does
 *
 * It is acknowledged, and that is deliberately all. Compass reads its sources by pulling a
 * half-open window through the connector port on a schedule (`ingest.tick`, every fifteen
 * minutes) — a webhook is a *hint* that something changed, not a record to be trusted. Acting on
 * the payload directly would mean the knowledge model could be written by whoever holds the
 * signing secret, and it would make the ingest path non-deterministic and non-replayable, which
 * every layer above it depends on. So a verified delivery answers 202 and says so in a sentence:
 * accepted, will be reflected by the next scheduled read. The alternative — pretending the payload
 * was ingested — would be a lie the freshness line would then have to tell.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/webhooks/[provider]';

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly provider: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const { provider: raw } = await context.params;
  if (!isWebhookProvider(raw)) {
    // Not a 401: nothing was claimed, so nothing failed to authenticate. Naming the providers
    // Compass accepts is safe — they are in the documentation — and it is the one thing that
    // makes a mistyped URL diagnosable.
    return jsonError(
      'unknown_provider',
      `\`${raw}\` is not a provider Compass accepts webhooks from. The providers are ${WEBHOOK_PROVIDERS.join(', ')}.`,
      404,
    );
  }
  const provider: WebhookProvider = raw;

  // Text, not JSON, and read exactly once. Every scheme below signs these bytes.
  const rawBody = await request.text();
  const verdict = verify(provider, rawBody, request, admitted.now);

  if (!isWebhookAccepted(verdict)) {
    // The log entry names the provider, which is the acceptance criterion: "a webhook was
    // rejected" is not actionable, and this says which secret to go and look at.
    console.warn(`[compass] ${describeWebhookVerdict(provider, verdict)}`);
    return jsonError(
      'signature_not_verified',
      `Compass could not verify that this delivery came from ${provider}, so it was refused and nothing was read ` +
        `from it. The signing secret Compass checks against is \`${WEBHOOK_SECRET_ENV_VAR[provider]}\`.`,
      401,
    );
  }

  console.info(
    `[compass] ${provider} webhook verified: ${describeDelivery(provider, request)} — ` +
      'acknowledged; the next scheduled ingest window will read the change.',
  );

  return jsonOk(
    {
      accepted: true,
      provider,
      detail:
        'Verified and accepted. Compass reads its sources by pulling a time window through the connector port on a ' +
        'schedule, so this delivery is a hint rather than a record: the change appears in the next incremental ' +
        'ingest, and the freshness line on the report states when that was.',
    },
    202,
  );
}

/** One provider, one verdict. The switch is total, so a fourth provider fails to typecheck. */
function verify(
  provider: WebhookProvider,
  rawBody: string,
  request: Request,
  now: Parameters<typeof verifySlackSignature>[0]['now'],
): WebhookVerdict {
  switch (provider) {
    case 'github':
      return verifyGithubSignature({
        rawBody,
        signature: request.headers.get(GITHUB_SIGNATURE_HEADER),
        secret: process.env[WEBHOOK_SECRET_ENV_VAR.github],
      });

    case 'slack':
      // The verifier `/api/slack/actions` already uses, so the two cannot disagree about what a
      // valid Slack request is. Its five-verdict vocabulary maps onto this module's.
      return slackWebhookVerdict(
        verifySlackSignature({
          rawBody,
          signature: request.headers.get(SLACK_SIGNATURE_HEADER),
          timestamp: request.headers.get(SLACK_TIMESTAMP_HEADER),
          now,
          secret: process.env[WEBHOOK_SECRET_ENV_VAR.slack],
        }),
      );

    case 'jira':
      return verifyJiraSignature({
        rawBody,
        signature: request.headers.get(JIRA_SIGNATURE_HEADER),
        authorization: request.headers.get(JIRA_AUTHORIZATION_HEADER),
        now,
        secret: process.env[WEBHOOK_SECRET_ENV_VAR.jira],
      });
  }
}

/**
 * What the success log says about a delivery.
 *
 * Identifiers only — the event name and the provider's delivery id. Never the body: a Jira issue
 * update carries summaries and comments, which is exactly the third-party text
 * `docs/ARCHITECTURE.md` says Compass does not spill into its own logs.
 */
function describeDelivery(provider: WebhookProvider, request: Request): string {
  if (provider === 'github') {
    const event = request.headers.get(GITHUB_EVENT_HEADER) ?? 'unnamed event';
    const delivery = request.headers.get(GITHUB_DELIVERY_HEADER) ?? 'no delivery id';
    return `${event} (${delivery})`;
  }
  return 'delivery accepted';
}
