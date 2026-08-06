import { RAW_TEXT_FIELD_NAMES, REDACTED, leaksIn } from '@compass/observability';
import { describe, expect, it } from 'vitest';

import { ERROR_REPORTING_CONSENTS } from '@compass/db';

import { SENTRY_DSN_ENV_VAR, errorReportingConfigured, initErrorReporting, sentryOptions } from '../lib/error-reporting';

/**
 * The criterion: no email address, token or raw ingested text reaches an error-reporter payload.
 *
 * Asserted by building a representative event and pushing it through **the real `beforeSend`** —
 * the one `Sentry.init` is handed — rather than through a copy of the scrubber. That is the whole
 * reason `sentryOptions()` returns the options object instead of the conventional
 * `sentry.server.config.ts` side effect: a scrubber no test can call is a scrubber nobody has
 * checked, and this criterion is exactly the kind that passes review as a comment.
 *
 * The fixtures below are deliberately the worst realistic event: a signed-in manager's address, a
 * bearer token in a header, a session cookie, a commit message, a pull request body, a ticket
 * comment and a chat message — every category the criterion names, in the fields Compass actually
 * puts them in.
 */

const DSN = 'https://examplepublickey@o0.ingest.sentry.io/0';

/** The raw ingested text. Every one of these is a string a source system's author wrote. */
const RAW_TEXT_FIXTURES = [
  'fix(checkout): stop double-charging on retry, refs PLAT-742',
  'This PR reverts the guest-checkout change because Priya found it drops the idempotency key.',
  'Marcus says the vendor will not confirm before Thursday, so this is blocked on them.',
  'DEV-522 is still waiting on the payments team, day 6.',
] as const;

const EMAIL = 'priya.raman@northwind.example';
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnopqrstuvwxyz012345';
const SESSION_TOKEN = 'sk_live_9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928';

const beforeSend = () => {
  const options = sentryOptions(DSN);
  const hook = options.beforeSend;
  if (typeof hook !== 'function') throw new Error('sentryOptions() declares no beforeSend');
  return hook;
};

/** A representative event, in the shape the SDK hands `beforeSend`. */
const representativeEvent = () =>
  ({
    message: `Failed to reconcile commit for ${EMAIL}`,
    user: { id: 'user-1', email: EMAIL, username: 'priya', ip_address: '203.0.113.9' },
    request: {
      url: 'https://compass.northwind.example/api/feedback',
      headers: {
        Authorization: BEARER,
        Cookie: `compass_session=${SESSION_TOKEN}`,
        'user-agent': 'Mozilla/5.0',
      },
      cookies: { compass_session: SESSION_TOKEN },
      data: { reason: `Not a risk, ${EMAIL} already handled it` },
    },
    extra: {
      // The raw-text fields by their real names, which is what the scrubber keys on.
      commitMessage: RAW_TEXT_FIXTURES[0],
      body: RAW_TEXT_FIXTURES[1],
      comment: RAW_TEXT_FIXTURES[2],
      message: RAW_TEXT_FIXTURES[3],
      searchedText: RAW_TEXT_FIXTURES[0],
      sessionToken: SESSION_TOKEN,
      undoTokenHash: SESSION_TOKEN,
      // Receipts, which must survive: they are what makes a crash report actionable.
      ticketKey: 'PLAT-742',
      pullRequest: '#883',
      revision: '7a8b9c0',
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: `ECONNREFUSED while notifying ${EMAIL} with ${BEARER}`,
        },
      ],
    },
    tags: { organizationId: '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', teamKey: 'platform' },
  }) as unknown as Parameters<ReturnType<typeof beforeSend>>[0];

describe('the event that leaves carries no personal data', () => {
  const scrubbed = () => beforeSend()(representativeEvent(), {});

  it('produces an event at all, so the assertions below are not about null', () => {
    // `beforeSend` returning null would drop the crash. Compass removes the private thing rather
    // than losing the report, and this pins that choice.
    expect(scrubbed()).not.toBeNull();
  });

  it('contains no address, no token-shaped string and none of the raw text', () => {
    const serialized = JSON.stringify(scrubbed());

    expect(leaksIn(serialized, RAW_TEXT_FIXTURES), 'these leaked into an error-reporter payload').toEqual([]);
  });

  it('drops the account email rather than masking it', () => {
    // Masking would still say "this crash belongs to an identifiable person". The id is enough to
    // correlate two reports without naming anybody.
    const event = scrubbed() as { user?: Record<string, unknown> };

    expect(event.user).not.toHaveProperty('email');
    expect(event.user).not.toHaveProperty('username');
    expect(event.user).not.toHaveProperty('ip_address');
    expect(event.user?.['id'], 'the correlating id should survive').toBe('user-1');
  });

  it('redacts the credential headers by name, whatever their value looks like', () => {
    const event = scrubbed() as { request?: { headers?: Record<string, string>; cookies?: unknown } };

    expect(event.request?.headers?.['Authorization']).toBe(REDACTED);
    expect(event.request?.headers?.['Cookie']).toBe(REDACTED);
    expect(event.request?.cookies).toBe(REDACTED);
    // A header that is not a credential is left readable, because a user agent is diagnostic.
    expect(event.request?.headers?.['user-agent']).toBe('Mozilla/5.0');
  });

  it('redacts every raw-text field by name', () => {
    const event = scrubbed() as { extra?: Record<string, unknown> };

    for (const field of ['commitMessage', 'body', 'comment', 'message', 'searchedText']) {
      expect(event.extra?.[field], `${field} survived`).toBe(REDACTED);
    }
  });

  it('keeps the receipts, because a crash report with no coordinates is not actionable', () => {
    const event = scrubbed() as { extra?: Record<string, unknown>; tags?: Record<string, unknown> };

    expect(event.extra?.['ticketKey']).toBe('PLAT-742');
    expect(event.extra?.['pullRequest']).toBe('#883');
    expect(event.extra?.['revision']).toBe('7a8b9c0');
    // And the organization, which is what makes a report attributable to a tenant. A UUID is not a
    // secret, and redacting it would defeat the reason the report exists.
    expect(event.tags?.['organizationId']).toBe('0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d');
  });

  it('scrubs a transaction through the same function, not a second one', () => {
    const options = sentryOptions(DSN);
    const hook = options.beforeSendTransaction;
    expect(typeof hook).toBe('function');

    // A span description is built from the same strings a message is, so a scrubber applied to only
    // one of the two hooks leaks through the other.
    const transaction = { message: `span for ${EMAIL}`, extra: { body: RAW_TEXT_FIXTURES[1] } } as never;
    const result = hook?.(transaction, {});

    expect(leaksIn(JSON.stringify(result), RAW_TEXT_FIXTURES)).toEqual([]);
  });

  it('is not vacuous: the same fixtures leak when the scrubber is skipped', () => {
    // Without this, every assertion above would still pass if `leaksIn` were broken.
    const raw = JSON.stringify(representativeEvent());

    expect(leaksIn(raw, RAW_TEXT_FIXTURES).length).toBeGreaterThan(0);
  });
});

describe('the structural gate', () => {
  it('never sends PII the exception did not already contain', () => {
    expect(sentryOptions(DSN).sendDefaultPii).toBe(false);
  });

  it('knows about every raw-text field the narration boundary does', async () => {
    /**
     * The same structural argument the narration path uses, one layer over.
     *
     * `@compass/narrator` fails the build if a raw-text field reaches the model. This asserts the
     * scrubber's list covers the narrator's, so teaching the report payload about a new raw-text
     * field is a build failure until the error reporter is taught to drop it too. Imported
     * dynamically because `@compass/observability` sits below the narrator and must not depend on
     * it — the agreement is asserted here rather than enforced by the module graph.
     */
    const { RAW_INGESTED_TEXT_FIELDS } = await import('@compass/narrator');

    const missing = RAW_INGESTED_TEXT_FIELDS.filter((field) => !RAW_TEXT_FIELD_NAMES.includes(field));

    expect(
      missing,
      'the narrator refuses to show these to a model, but the error reporter would still send them',
    ).toEqual([]);
  });
});

describe('a deployment with no DSN', () => {
  it('does not initialize, and says so rather than pretending', () => {
    expect(initErrorReporting({ consent: 'granted', environment: {} })).toBe(false);
    expect(errorReportingConfigured({})).toBe(false);
  });

  it('reports configured when a DSN is present', () => {
    expect(errorReportingConfigured({ [SENTRY_DSN_ENV_VAR]: DSN })).toBe(true);
  });
});

/**
 * The consent gate, as a truth table.
 *
 * Two independent conditions decide whether a stack trace can leave the process — the operator has
 * configured a destination, and the organization has agreed to it — and either one alone used to be
 * enough because only the first existed. Enumerated rather than spot-checked, because the failure
 * this guards against is one arm of a boolean quietly inverting and nothing looking different until
 * an organization's traces are in a third party's dashboard.
 */
describe('consent decides whether the reporter starts at all', () => {
  const withDsn = { [SENTRY_DSN_ENV_VAR]: DSN };

  it.each([
    ['unset', false],
    ['denied', false],
  ] as const)('stays silent with a DSN configured and consent %s', (consent, expected) => {
    // The important half. A configured deployment reports *nothing* until somebody answers, so the
    // window between deploying and deciding is not a window in which data leaves.
    expect(initErrorReporting({ consent, environment: withDsn })).toBe(expected);
  });

  it.each(['unset', 'granted', 'denied'] as const)('stays silent with no DSN and consent %s', (consent) => {
    // Consent is permission, not configuration. Agreeing does not conjure a destination.
    expect(initErrorReporting({ consent, environment: {} })).toBe(false);
  });

  it('defaults to unset when the caller says nothing', () => {
    /**
     * The signature's own safety property. `initErrorReporting()` with no argument is what a
     * careless future call site looks like, and it must fail closed — a default of `granted` would
     * make the gate opt-out by accident rather than opt-in by design.
     */
    expect(initErrorReporting()).toBe(false);
  });

  it('treats denied and unset identically here, and they are still different values', () => {
    // Same behaviour, different meanings: the banner shows for one and not the other. If these ever
    // collapse into a boolean, the banner loses the only thing it keys on.
    expect(ERROR_REPORTING_CONSENTS).toEqual(['unset', 'granted', 'denied']);
    expect(initErrorReporting({ consent: 'unset', environment: withDsn })).toBe(
      initErrorReporting({ consent: 'denied', environment: withDsn }),
    );
  });
});
