import { instantFromIso, type Instant } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  SLACK_ACTION_PREFIX,
  SLACK_NO_ACCESS_MESSAGE,
  SLACK_SIGNATURE_VERSION,
  SLACK_TIMESTAMP_WINDOW_MILLIS,
  SLACK_TIMESTAMP_WINDOW_SECONDS,
  parseSlackInteraction,
  renderSlackBlocks,
  slackActionId,
  slackSignatureFor,
  verifySlackSignature,
} from '@compass/delivery';

import { renderedReport } from './helpers/report.js';

/**
 * Slack interactivity: the signature, the replay window, and the payload.
 *
 * The signature is produced here with the real algorithm rather than compared against a fixture,
 * which is what makes the negative cases meaningful — a test asserting against a hard-coded string
 * would pass for an implementation that always returned `false`.
 */

const SECRET = 'slack-signing-secret-not-a-default';
const NOW: Instant = instantFromIso('2026-08-03T06:00:00Z');
const BODY = 'payload=%7B%22user%22%3A%7B%22id%22%3A%22U123%22%7D%7D';

const stamp = (at: Instant): string => String(Math.floor(at / 1000));

const signed = (body: string, at: Instant = NOW) => ({
  rawBody: body,
  signature: slackSignatureFor(body, stamp(at), SECRET),
  timestamp: stamp(at),
  now: NOW,
  secret: SECRET,
});

describe('the v0 signature is verified over the raw body', () => {
  it('accepts a genuine signature', () => {
    expect(verifySlackSignature(signed(BODY))).toBe('verified');
  });

  it('produces the documented shape', () => {
    expect(slackSignatureFor(BODY, stamp(NOW), SECRET).startsWith(`${SLACK_SIGNATURE_VERSION}=`)).toBe(true);
    expect(slackSignatureFor(BODY, stamp(NOW), SECRET)).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it('refuses a body that changed by one byte', () => {
    // The whole reason the handler must not parse and re-serialise before verifying: any change to
    // the bytes — key order, whitespace, a unicode escape — is a different signature.
    const genuine = signed(BODY);
    expect(verifySlackSignature({ ...genuine, rawBody: `${BODY} ` })).toBe('bad_signature');
  });

  it('refuses a signature computed under a different secret', () => {
    expect(
      verifySlackSignature({ ...signed(BODY), signature: slackSignatureFor(BODY, stamp(NOW), 'other-secret') }),
    ).toBe('bad_signature');
  });

  it('refuses a signature over a different timestamp than the header claims', () => {
    const earlier = (NOW - 60_000) as Instant;
    expect(
      verifySlackSignature({ ...signed(BODY), signature: slackSignatureFor(BODY, stamp(earlier), SECRET) }),
    ).toBe('bad_signature');
  });

  it('refuses when either header is missing', () => {
    expect(verifySlackSignature({ ...signed(BODY), signature: null })).toBe('missing_headers');
    expect(verifySlackSignature({ ...signed(BODY), timestamp: null })).toBe('missing_headers');
    expect(verifySlackSignature({ ...signed(BODY), timestamp: 'not-a-number' })).toBe('missing_headers');
  });

  it('refuses everything when no signing secret is configured', () => {
    // A deployment that cannot verify must not act. `/api/slack/actions` turns this into a 503.
    expect(verifySlackSignature({ ...signed(BODY), secret: undefined })).toBe('unconfigured');
    expect(verifySlackSignature({ ...signed(BODY), secret: '' })).toBe('unconfigured');
  });
});

describe('the five-minute timestamp window', () => {
  it('is documented as a number', () => {
    expect(SLACK_TIMESTAMP_WINDOW_SECONDS).toBe(300);
    expect(SLACK_TIMESTAMP_WINDOW_MILLIS).toBe(300_000);
  });

  it('accepts a request inside the window', () => {
    const at = (NOW - SLACK_TIMESTAMP_WINDOW_MILLIS + 1000) as Instant;
    expect(verifySlackSignature(signed(BODY, at))).toBe('verified');
  });

  it('refuses a captured request replayed after the window', () => {
    const at = (NOW - SLACK_TIMESTAMP_WINDOW_MILLIS - 1000) as Instant;
    expect(verifySlackSignature(signed(BODY, at))).toBe('stale_timestamp');
  });

  it('refuses a timestamp from the future by the same margin', () => {
    // A request dated an hour ahead is a broken clock or somebody extending their own window, and
    // neither is a request to act on. The comparison is on absolute difference for that reason.
    const at = (NOW + SLACK_TIMESTAMP_WINDOW_MILLIS + 1000) as Instant;
    expect(verifySlackSignature(signed(BODY, at))).toBe('stale_timestamp');
  });
});

describe('the interaction payload', () => {
  const payload = (body: Record<string, unknown>): string =>
    new URLSearchParams({ payload: JSON.stringify(body) }).toString();

  it('reads the acting user, the channel and the Compass actions', () => {
    const parsed = parseSlackInteraction(
      payload({
        user: { id: 'U123', name: 'priya' },
        team: { id: 'T900' },
        channel: { id: 'C500' },
        response_url: 'https://hooks.slack.example/actions/1',
        actions: [{ action_id: slackActionId('dismiss_risk'), value: 'v1:8f2c1a0b3d4e5f60' }],
      }),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.slackUserId).toBe('U123');
    expect(parsed?.slackTeamId).toBe('T900');
    expect(parsed?.channelId).toBe('C500');
    expect(parsed?.responseUrl).toBe('https://hooks.slack.example/actions/1');
    expect(parsed?.actions).toEqual([{ action: 'dismiss_risk', itemStableId: 'v1:8f2c1a0b3d4e5f60' }]);
  });

  it('refuses a payload with no acting user rather than defaulting one', () => {
    // An interaction Compass cannot attribute is one it cannot authorize, and a placeholder would
    // authorize it as somebody.
    expect(parseSlackInteraction(payload({ actions: [] }))).toBeNull();
    expect(parseSlackInteraction(payload({ user: {} }))).toBeNull();
    expect(parseSlackInteraction(payload({ user: { id: '' } }))).toBeNull();
  });

  it('refuses a body that is not a Slack interaction at all', () => {
    expect(parseSlackInteraction('')).toBeNull();
    expect(parseSlackInteraction('payload=not-json')).toBeNull();
    expect(parseSlackInteraction('payload=%5B%5D')).toBeNull();
  });

  it('ignores another app’s buttons', () => {
    const parsed = parseSlackInteraction(
      payload({
        user: { id: 'U123' },
        actions: [
          { action_id: 'someone_elses_button', value: 'whatever' },
          { action_id: slackActionId('snooze'), value: 'v1:aa' },
        ],
      }),
    );

    expect(parsed?.actions).toEqual([{ action: 'snooze', itemStableId: 'v1:aa' }]);
  });

  it('ignores a Compass button with no item on it', () => {
    const parsed = parseSlackInteraction(
      payload({ user: { id: 'U123' }, actions: [{ action_id: slackActionId('snooze') }] }),
    );

    expect(parsed?.actions).toEqual([]);
  });
});

describe('the refusal an unmapped or unauthorized click gets', () => {
  it('is ephemeral, leaves the report alone, and names the fix', () => {
    // Both properties matter: a manager's daily must not be rewritten because a colleague pressed a
    // button in a shared channel, and telling the channel that somebody lacks access would be a small
    // public humiliation for a configuration gap.
    expect(SLACK_NO_ACCESS_MESSAGE.response_type).toBe('ephemeral');
    expect(SLACK_NO_ACCESS_MESSAGE.replace_original).toBe(false);
    expect(SLACK_NO_ACCESS_MESSAGE.text).toContain('don’t have access');
    expect(SLACK_NO_ACCESS_MESSAGE.text).toContain('Nothing has been changed.');
    // "You don't have access" with no route forward is how an internal tool gets a reputation for
    // being broken.
    expect(SLACK_NO_ACCESS_MESSAGE.text).toContain('ask an owner');
  });
});

describe('the buttons in a delivered report', () => {
  const report = renderedReport();
  const claim = report.sections.flatMap((section) => section.claims)[0];

  it('carries the item id in the button value, not in the action id', () => {
    // `action_id` must be unique within a Slack message, and a report with two dismissible risks
    // would collide on the first one if the id travelled there.
    const blocks = renderSlackBlocks(report, {
      reportUrl: 'https://compass.acme.example/',
      itemActions: [
        {
          itemStableId: claim!.stableId,
          headline: 'CHK-701 has not moved in 6 working days',
          actions: [{ action: 'blocker_already_resolved', label: 'Already resolved' }],
        },
      ],
    });

    const actions = blocks.find((block) => block.type === 'actions');
    expect(actions).toBeDefined();
    expect(actions?.block_id).toBe(`compass_item:${claim!.stableId}`);

    const [button] = (actions?.elements ?? []) as readonly Record<string, unknown>[];
    expect(button?.['action_id']).toBe(`${SLACK_ACTION_PREFIX}blocker_already_resolved`);
    expect(button?.['value']).toBe(claim!.stableId);
  });

  it('emits no actions block for a report with no offers', () => {
    const blocks = renderSlackBlocks(report, { reportUrl: 'https://compass.acme.example/' });
    expect(blocks.some((block) => block.type === 'actions')).toBe(false);
  });

  it('carries the change line above the six sections', () => {
    const blocks = renderSlackBlocks(report, { reportUrl: 'https://compass.acme.example/' });
    const firstDivider = blocks.findIndex((block) => block.type === 'divider');
    const changeBlock = blocks
      .slice(0, firstDivider)
      .find((block) => JSON.stringify(block.elements ?? []).includes('carried over'));

    expect(changeBlock, 'the change line belongs above the sections, not after them').toBeDefined();
  });
});
