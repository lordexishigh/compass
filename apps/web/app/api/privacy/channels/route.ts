import { CONVERSATION_KINDS, type ConversationKind } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../../lib/auth/http';
import { saveChannelIngestion } from '../../../../lib/privacy-source';

/**
 * `/api/privacy/channels` — turn Slack ingestion on or off for one named channel.
 *
 * There is no "enable all", no wildcard and no pattern. A conversation Compass reads is a
 * row somebody wrote, which is what makes "which channels does Compass read" answerable by
 * reading a table rather than by reasoning about a filter.
 *
 * ## What happens when a private channel is named
 *
 * A 409 with a sentence, from `PrivateConversationError`. Not a 400: the request is well
 * formed and the *state of the world* is the problem — that conversation is private, and no
 * amount of correcting the JSON changes it. The refusal says that direct messages and
 * private channels are outside what Compass reads at all rather than merely switched off,
 * because a manager who reads "not enabled" will go looking for the switch.
 *
 * Three guards enforce the same rule and each does something the others cannot: the CHECK
 * constraint makes the row unwritable, this route makes the refusal legible, and the ingest
 * filter drops the record even if a row somehow existed.
 *
 * ## Enabling does not post the notice
 *
 * `privacy.channel-notice` does, on its own schedule. Slack being unreachable must not turn
 * a manager's settings change into an error page, and the notice has to be retried until it
 * lands rather than lost with the failed request. Until it posts, the settings page says in
 * plain words that the team has not been told.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/privacy/channels';

export async function PATCH(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'PATCH' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const conversationKey = requiredString(parsed.body, 'conversationKey');
  if ('response' in conversationKey) return conversationKey.response;
  const conversationName = requiredString(parsed.body, 'conversationName');
  if ('response' in conversationName) return conversationName.response;

  const rawKind = parsed.body['conversationKind'];
  if (typeof rawKind !== 'string' || !(CONVERSATION_KINDS as readonly string[]).includes(rawKind)) {
    return jsonError(
      'invalid_request',
      `\`conversationKind\` must be one of ${CONVERSATION_KINDS.join(', ')}. It is required rather than assumed: ` +
        'defaulting it to `public_channel` would mean a provider that stopped reporting the kind silently started ' +
        'looking like it was reporting public channels.',
      400,
    );
  }

  const rawEnabled = parsed.body['enabled'];
  if (typeof rawEnabled !== 'boolean') {
    return jsonError('invalid_request', '`enabled` must be true or false.', 400);
  }

  try {
    const channel = await saveChannelIngestion(
      admitted.scoped,
      {
        conversationKey: conversationKey.value,
        conversationName: conversationName.value,
        conversationKind: rawKind as ConversationKind,
        enabled: rawEnabled,
      },
      admitted.identity,
      admitted.now,
    );

    return jsonOk({
      conversationKey: channel.conversationKey,
      enabled: channel.enabled,
      detail: rawEnabled
        ? 'Enabled. Compass will post a notice in the channel stating that it reads it, and will keep trying until ' +
          'that lands — the settings page says so until it has. Messages are kept only as long as the retention ' +
          'window allows, and none of their text is ever shown to a language model.'
        : 'Disabled. Compass stops reading it from the next ingest. Messages it already holds are kept until the ' +
          'retention window deletes them, which is what the window is for; the export includes them until then.',
    });
  } catch (error) {
    return failure(error);
  }
}
