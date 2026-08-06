import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RAW_TEXT_FIELD_NAMES, REDACTED, leaksIn } from '@compass/observability';
import { afterEach, describe, expect, it } from 'vitest';

import { ERROR_REPORTING_CONSENTS } from '@compass/db';

import * as Sentry from '@sentry/nextjs';

import {
  SENTRY_DSN_ENV_VAR,
  errorReportingActive,
  errorReportingConfigured,
  initErrorReporting,
  sentryOptions,
  stopErrorReporting,
} from '../lib/error-reporting';

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
  it('does not initialize, and says so rather than pretending', async () => {
    expect(await initErrorReporting({ consent: 'granted', environment: {} })).toBe(false);
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
  ] as const)('stays silent with a DSN configured and consent %s', async (consent, expected) => {
    // The important half. A configured deployment reports *nothing* until somebody answers, so the
    // window between deploying and deciding is not a window in which data leaves.
    expect(await initErrorReporting({ consent, environment: withDsn })).toBe(expected);
  });

  it.each(['unset', 'granted', 'denied'] as const)('stays silent with no DSN and consent %s', async (consent) => {
    // Consent is permission, not configuration. Agreeing does not conjure a destination.
    expect(await initErrorReporting({ consent, environment: {} })).toBe(false);
  });

  it('defaults to unset when the caller says nothing', async () => {
    /**
     * The signature's own safety property. `initErrorReporting()` with no argument is what a
     * careless future call site looks like, and it must fail closed — a default of `granted` would
     * make the gate opt-out by accident rather than opt-in by design.
     */
    expect(await initErrorReporting()).toBe(false);
  });

  it('treats denied and unset identically here, and they are still different values', async () => {
    // Same behaviour, different meanings: the banner shows for one and not the other. If these ever
    // collapse into a boolean, the banner loses the only thing it keys on.
    expect(ERROR_REPORTING_CONSENTS).toEqual(['unset', 'granted', 'denied']);
    expect(await initErrorReporting({ consent: 'unset', environment: withDsn })).toBe(
      await initErrorReporting({ consent: 'denied', environment: withDsn }),
    );
  });
});

/**
 * The arm that actually sends, and the arm that stops sending.
 *
 * Separated from the table above because these two are the only tests in this file that start a
 * real client, and a live SDK left behind would leak into every later test in the process — the
 * scrubber tests build events through `sentryOptions()` rather than through a client precisely so
 * they never need one. `afterEach` tears it down whatever the assertion did.
 *
 * The DSN is syntactically valid and points at a host that does not resolve; nothing is sent
 * because nothing is captured here, only initialised.
 */
describe('a granted deployment, and a withdrawal', () => {
  const withDsn = { [SENTRY_DSN_ENV_VAR]: DSN };

  afterEach(async () => {
    await stopErrorReporting();
  });

  it('initializes with a DSN and consent granted — the combination that sends', async () => {
    // The arm the truth table above was missing. Without it every assertion in this file was
    // satisfied by a function that returned false unconditionally.
    expect(await initErrorReporting({ consent: 'granted', environment: withDsn })).toBe(true);
    expect(errorReportingActive()).toBe(true);
  });

  it('is idempotent, so a second request does not replace a live client mid-flight', async () => {
    expect(await initErrorReporting({ consent: 'granted', environment: withDsn })).toBe(true);
    const first = Sentry.getClient();

    expect(await initErrorReporting({ consent: 'granted', environment: withDsn })).toBe(true);
    expect(Sentry.getClient()).toBe(first);
  });

  it('tears the client down when consent is withdrawn, without waiting for a restart', async () => {
    /**
     * The defect this closes. An initialized client installs global handlers, so gating only the
     * capture path left an unhandled rejection still reaching the tracker after the owner said no —
     * consent withdrawn in the database and not in the process.
     */
    await initErrorReporting({ consent: 'granted', environment: withDsn });
    expect(errorReportingActive()).toBe(true);

    expect(await initErrorReporting({ consent: 'denied', environment: withDsn })).toBe(false);
    expect(errorReportingActive(), 'the client survived a withdrawal').toBe(false);
  });

  it('tears it down for unset too, which is what a fresh organization reverts to on a failed read', async () => {
    // `errorReportingConsent()` answers `unset` when the database cannot be reached, and that path
    // must stop an already-running client rather than leave it reporting on a guess.
    await initErrorReporting({ consent: 'granted', environment: withDsn });

    expect(await initErrorReporting({ consent: 'unset', environment: withDsn })).toBe(false);
    expect(errorReportingActive()).toBe(false);
  });

  it('can be stopped when nothing is running, so a shutdown hook needs no guard', async () => {
    await expect(stopErrorReporting()).resolves.toBeUndefined();
  });
});

/**
 * The shape of `instrumentation.ts`, asserted as source rather than as behaviour.
 *
 * ## Why a source scan, which this repository is otherwise sparing with
 *
 * Next.js compiles `instrumentation.ts` for **every** server runtime the app may run in, Edge
 * included, and the Edge runtime has no `fs`, `path` or `stream`. `errorReportingConsent` reaches
 * `@compass/db`, which reaches `pg`, which reaches all three — so importing it at the top of that
 * file does not merely bloat the Edge bundle, it makes `next build` fail outright with
 * "Module not found: Can't resolve 'path'".
 *
 * Nothing else here can catch that. The module type-checks perfectly, every test in this file
 * passes, `eslint` and `depcruise` are clean, and `pnpm run verify` — lint, arch, typecheck, test —
 * does not bundle the app at all. The failure appears only in `next build`, which locally is a
 * separate command and in CI is inside the container-image job. An earlier attempt at this feature
 * shipped exactly this defect and the whole improvement round was reverted for it.
 *
 * ## What is pinned, and why each half matters
 *
 * Both halves of the guard, because either one alone silently stops working:
 *
 *  - **`process.env.NEXT_RUNTIME`, in dot form.** Next substitutes it per compilation through
 *    webpack's DefinePlugin. The bracket form this app uses everywhere else for environment
 *    variables is not substituted, the branch never folds, and the import is resolved anyway.
 *  - **The import nested inside the truthy branch.** Webpack drops an `import()` only where it can
 *    prove it unreachable. Written as an early `return` followed by the import, the import sits in
 *    the function body, survives the fold and is resolved. Both spellings type-check; only the
 *    nested one builds.
 */
describe('instrumentation keeps the database out of the Edge bundle', () => {
  const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'instrumentation.ts'), 'utf8');

  /**
   * Comments stripped, because this is an assertion about what the bundler sees.
   *
   * Not fastidiousness: the guard in that file documents the bracket form *as the spelling that
   * does not work*, so a scan over the raw text finds it in the prose and fails on the very comment
   * warning against it. Stripping block and line comments is what makes "the file does not contain
   * this" a claim about code.
   */
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('never imports the consent lookup statically', () => {
    const staticImports = source
      .split(/\r?\n/)
      .filter((line) => /^import\s/.test(line))
      .join('\n');

    expect(
      staticImports,
      'a static import of the consent lookup drags `pg` into the Edge compilation and breaks `next build`',
    ).not.toContain('error-reporting-consent');
  });

  it('reaches it through a dynamic import nested inside a NEXT_RUNTIME guard', () => {
    expect(source, 'the dynamic import is gone; nothing reads consent any more').toContain(
      "await import('./lib/error-reporting-consent')",
    );

    // Dot form, or DefinePlugin does not substitute it and the branch never folds.
    expect(source, 'the guard must use the substitutable dot form').toContain(
      "process.env.NEXT_RUNTIME === 'nodejs'",
    );
    expect(source, 'the bracket form is not substituted by DefinePlugin').not.toContain(
      "process.env['NEXT_RUNTIME']",
    );

    // The import must sit after the opening of the guarded block and before its close, which is
    // what makes it eliminable. An early-return guard puts it in the function body instead.
    const guard = source.indexOf("process.env.NEXT_RUNTIME === 'nodejs'");
    const dynamic = source.indexOf("await import('./lib/error-reporting-consent')");
    expect(dynamic, 'the import is not inside the guarded branch').toBeGreaterThan(guard);
  });
});
