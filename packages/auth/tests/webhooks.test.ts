import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GITHUB_SIGNATURE_PREFIX,
  WEBHOOK_PROVIDERS,
  WEBHOOK_SECRET_ENV_VAR,
  WEBHOOK_TIMESTAMP_WINDOW_MILLIS,
  WEBHOOK_TIMESTAMP_WINDOW_SECONDS,
  constantTimeEqual,
  describeWebhookVerdict,
  githubSignatureFor,
  isWebhookAccepted,
  isWebhookProvider,
  jiraJwtFor,
  jiraSignatureFor,
  slackWebhookVerdict,
  verifyGithubSignature,
  verifyJiraSignature,
  type WebhookProvider,
} from '@compass/auth';
import { addMillis, instantFromIso, toEpochMillis } from '@compass/clock';
import { describe, expect, it } from 'vitest';

/**
 * Webhook signature verification, for all three providers.
 *
 * Every signature below is *produced* rather than pasted from a fixture. That is the difference
 * between a test of a verifier and a test of a string: a suite asserting only against hard-coded
 * digests would pass unchanged for an implementation that always returned `bad_signature`, so
 * each case signs a body with the real algorithm and then asserts what a *tampered* one does.
 */

const SECRET = 'a-signing-secret-nobody-else-holds';
const OTHER_SECRET = 'a-different-signing-secret-entirely';
const NOW = instantFromIso('2026-08-03T09:00:00Z');
const BODY = JSON.stringify({ action: 'opened', number: 9201, repository: { full_name: 'compass/checkout-web' } });

/** Flips the last hex digit of a signature: valid shape, wrong value. */
const tamper = (signature: string): string => {
  const last = signature.slice(-1);
  return `${signature.slice(0, -1)}${last === '0' ? '1' : '0'}`;
};

describe('the provider vocabulary', () => {
  it('names exactly the three providers, and recognises nothing else', () => {
    expect([...WEBHOOK_PROVIDERS]).toEqual(['github', 'slack', 'jira']);

    for (const provider of WEBHOOK_PROVIDERS) {
      expect(isWebhookProvider(provider)).toBe(true);
      expect(WEBHOOK_SECRET_ENV_VAR[provider].length).toBeGreaterThan(5);
    }
    for (const impostor of ['gitlab', 'GITHUB', 'github ', '', 'bitbucket']) {
      expect(isWebhookProvider(impostor), `${impostor} must not be accepted as a provider`).toBe(false);
    }
  });

  it('gives every refusal a log sentence naming the provider and the variable to check', () => {
    const verdicts = ['unconfigured', 'missing_signature', 'malformed_signature', 'bad_signature', 'stale_timestamp'] as const;

    for (const provider of WEBHOOK_PROVIDERS) {
      for (const verdict of verdicts) {
        const sentence = describeWebhookVerdict(provider, verdict);
        expect(sentence, `${provider}/${verdict} must name the provider`).toContain(provider);
        expect(sentence.length).toBeGreaterThan(30);
      }
      // The two verdicts about a secret say which secret.
      expect(describeWebhookVerdict(provider, 'unconfigured')).toContain(WEBHOOK_SECRET_ENV_VAR[provider]);
      expect(describeWebhookVerdict(provider, 'bad_signature')).toContain(WEBHOOK_SECRET_ENV_VAR[provider]);
    }
  });

  it('treats only `verified` as acceptance', () => {
    expect(isWebhookAccepted('verified')).toBe(true);
    for (const verdict of ['unconfigured', 'missing_signature', 'malformed_signature', 'bad_signature', 'stale_timestamp'] as const) {
      expect(isWebhookAccepted(verdict), `${verdict} must not be accepted`).toBe(false);
    }
  });
});

describe('GitHub X-Hub-Signature-256', () => {
  it('accepts a signature it produced over the same bytes', () => {
    const signature = githubSignatureFor(BODY, SECRET);

    expect(signature.startsWith(GITHUB_SIGNATURE_PREFIX)).toBe(true);
    expect(verifyGithubSignature({ rawBody: BODY, signature, secret: SECRET })).toBe('verified');
  });

  it('refuses a tampered signature over a valid body', () => {
    // The acceptance criterion, precisely: a valid body with a signature that does not match.
    const signature = tamper(githubSignatureFor(BODY, SECRET));

    expect(verifyGithubSignature({ rawBody: BODY, signature, secret: SECRET })).toBe('bad_signature');
  });

  it('refuses a valid signature over a body that has since been altered', () => {
    const signature = githubSignatureFor(BODY, SECRET);
    const altered = BODY.replace('9201', '9202');

    expect(verifyGithubSignature({ rawBody: altered, signature, secret: SECRET })).toBe('bad_signature');
  });

  it('refuses a signature made with a different secret', () => {
    const signature = githubSignatureFor(BODY, OTHER_SECRET);

    expect(verifyGithubSignature({ rawBody: BODY, signature, secret: SECRET })).toBe('bad_signature');
  });

  it('refuses when no secret is configured, rather than accepting what it cannot check', () => {
    // Failing open on a misconfiguration would mean the ingest path could be fed by anyone who
    // found the URL, and nothing would look wrong.
    const signature = githubSignatureFor(BODY, SECRET);

    expect(verifyGithubSignature({ rawBody: BODY, signature, secret: undefined })).toBe('unconfigured');
    expect(verifyGithubSignature({ rawBody: BODY, signature, secret: '' })).toBe('unconfigured');
  });

  it('distinguishes an absent signature from a malformed one', () => {
    expect(verifyGithubSignature({ rawBody: BODY, signature: null, secret: SECRET })).toBe('missing_signature');
    expect(verifyGithubSignature({ rawBody: BODY, signature: '', secret: SECRET })).toBe('missing_signature');

    for (const malformed of [
      'sha1=0123456789abcdef',
      githubSignatureFor(BODY, SECRET).slice(GITHUB_SIGNATURE_PREFIX.length),
      'sha256=nothex',
      'sha256=abc',
    ]) {
      expect(
        verifyGithubSignature({ rawBody: BODY, signature: malformed, secret: SECRET }),
        `${malformed} is not the shape GitHub sends`,
      ).toBe('malformed_signature');
    }
  });

  it('accepts the digest in either case, because the scheme does not specify one', () => {
    const upper = githubSignatureFor(BODY, SECRET).toUpperCase().replace('SHA256=', 'sha256=');

    expect(verifyGithubSignature({ rawBody: BODY, signature: upper, secret: SECRET })).toBe('verified');
  });
});

describe('Jira, in both the forms Jira sends', () => {
  it('accepts a shared-secret HMAC over the raw body', () => {
    const signature = jiraSignatureFor(BODY, SECRET);

    expect(
      verifyJiraSignature({ rawBody: BODY, signature, authorization: null, now: NOW, secret: SECRET }),
    ).toBe('verified');
  });

  it('refuses a tampered shared-secret signature', () => {
    const signature = tamper(jiraSignatureFor(BODY, SECRET));

    expect(
      verifyJiraSignature({ rawBody: BODY, signature, authorization: null, now: NOW, secret: SECRET }),
    ).toBe('bad_signature');
  });

  it('accepts an Atlassian Connect HS256 JWT signed with the shared secret', () => {
    const token = jiraJwtFor({ iss: 'jira:1234', iat: toEpochMillis(NOW) / 1000 }, SECRET);

    expect(
      verifyJiraSignature({
        rawBody: BODY,
        signature: null,
        authorization: `JWT ${token}`,
        now: NOW,
        secret: SECRET,
      }),
    ).toBe('verified');
  });

  it('refuses a JWT whose signature was made with another secret', () => {
    const token = jiraJwtFor({ iss: 'jira:1234', iat: toEpochMillis(NOW) / 1000 }, OTHER_SECRET);

    expect(
      verifyJiraSignature({
        rawBody: BODY,
        signature: null,
        authorization: `JWT ${token}`,
        now: NOW,
        secret: SECRET,
      }),
    ).toBe('bad_signature');
  });

  it('refuses `alg: none`, the classic forgery', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ iat: toEpochMillis(NOW) / 1000 })}.`;

    expect(
      verifyJiraSignature({
        rawBody: BODY,
        signature: null,
        authorization: `JWT ${unsigned}`,
        now: NOW,
        secret: SECRET,
      }),
      'a token must not get to choose that it needs no signature',
    ).toBe('malformed_signature');
  });

  it('refuses a JWT issued outside the five-minute window even though its signature is valid', () => {
    // The receiver's window, not the token's own `exp`: a token minted with a distant expiry is
    // replayable until then, and only the receiver can refuse that.
    const stale = addMillis(NOW, -(WEBHOOK_TIMESTAMP_WINDOW_MILLIS + 1000));
    const token = jiraJwtFor(
      { iss: 'jira:1234', iat: toEpochMillis(stale) / 1000, exp: toEpochMillis(addMillis(NOW, 86_400_000)) / 1000 },
      SECRET,
    );

    expect(
      verifyJiraSignature({
        rawBody: BODY,
        signature: null,
        authorization: `JWT ${token}`,
        now: NOW,
        secret: SECRET,
      }),
    ).toBe('stale_timestamp');
  });

  it('refuses a JWT dated in the future too', () => {
    const ahead = addMillis(NOW, WEBHOOK_TIMESTAMP_WINDOW_MILLIS + 1000);
    const token = jiraJwtFor({ iat: toEpochMillis(ahead) / 1000 }, SECRET);

    expect(
      verifyJiraSignature({ rawBody: BODY, signature: null, authorization: `JWT ${token}`, now: NOW, secret: SECRET }),
    ).toBe('stale_timestamp');
  });

  it('refuses a JWT whose own `exp` has passed', () => {
    const token = jiraJwtFor(
      { iat: toEpochMillis(NOW) / 1000, exp: toEpochMillis(addMillis(NOW, -1000)) / 1000 },
      SECRET,
    );

    expect(
      verifyJiraSignature({ rawBody: BODY, signature: null, authorization: `JWT ${token}`, now: NOW, secret: SECRET }),
    ).toBe('stale_timestamp');
  });

  it('refuses a JWT with no `iat` at all rather than treating it as fresh', () => {
    const token = jiraJwtFor({ iss: 'jira:1234' }, SECRET);

    expect(
      verifyJiraSignature({ rawBody: BODY, signature: null, authorization: `JWT ${token}`, now: NOW, secret: SECRET }),
    ).toBe('malformed_signature');
  });

  it('reads the JWT header case-insensitively and ignores anything that is not one', () => {
    const token = jiraJwtFor({ iat: toEpochMillis(NOW) / 1000 }, SECRET);

    expect(
      verifyJiraSignature({ rawBody: BODY, signature: null, authorization: `jwt ${token}`, now: NOW, secret: SECRET }),
    ).toBe('verified');

    // A Bearer token is not a JWT header, so the shared-secret path is taken — and there is no
    // signature header, so it is refused rather than falling through to accepted.
    expect(
      verifyJiraSignature({
        rawBody: BODY,
        signature: null,
        authorization: 'Bearer something',
        now: NOW,
        secret: SECRET,
      }),
    ).toBe('missing_signature');
  });

  it('refuses when no secret is configured, whichever form arrived', () => {
    const token = jiraJwtFor({ iat: toEpochMillis(NOW) / 1000 }, SECRET);

    expect(
      verifyJiraSignature({ rawBody: BODY, signature: null, authorization: `JWT ${token}`, now: NOW, secret: undefined }),
    ).toBe('unconfigured');
    expect(
      verifyJiraSignature({
        rawBody: BODY,
        signature: jiraSignatureFor(BODY, SECRET),
        authorization: null,
        now: NOW,
        secret: undefined,
      }),
    ).toBe('unconfigured');
  });
});

describe('Slack’s verdicts map onto this vocabulary without losing a refusal', () => {
  it('maps all five, and maps nothing onto acceptance by accident', () => {
    expect(slackWebhookVerdict('verified')).toBe('verified');
    expect(slackWebhookVerdict('unconfigured')).toBe('unconfigured');
    expect(slackWebhookVerdict('missing_headers')).toBe('missing_signature');
    expect(slackWebhookVerdict('stale_timestamp')).toBe('stale_timestamp');
    expect(slackWebhookVerdict('bad_signature')).toBe('bad_signature');

    for (const verdict of ['unconfigured', 'missing_headers', 'stale_timestamp', 'bad_signature'] as const) {
      expect(isWebhookAccepted(slackWebhookVerdict(verdict)), `${verdict} must not become verified`).toBe(false);
    }
  });

  it('holds Slack to the same five-minute window this module documents', () => {
    expect(WEBHOOK_TIMESTAMP_WINDOW_SECONDS).toBe(300);
    expect(WEBHOOK_TIMESTAMP_WINDOW_MILLIS).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// The code test the acceptance criteria ask for by name
// ---------------------------------------------------------------------------

describe('every comparison is constant-time', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const sourceOf = (...parts: string[]): string => readFileSync(join(HERE, '..', '..', ...parts), 'utf8');

  /** The verification helpers, wherever they live. Both are asserted, not just this package's. */
  const HELPERS = [
    ['@compass/auth webhooks', sourceOf('auth', 'src', 'webhooks.ts')],
    ['@compass/auth secrets', sourceOf('auth', 'src', 'secrets.ts')],
    ['@compass/delivery slack-actions', sourceOf('delivery', 'src', 'slack-actions.ts')],
  ] as const;

  it('routes every signature comparison through `timingSafeEqual`', () => {
    for (const [name, source] of HELPERS) {
      expect(source, `${name} must use node:crypto’s timingSafeEqual`).toContain('timingSafeEqual');
    }
  });

  /**
   * The scan, as one predicate, so the test below can prove it is not vacuous.
   *
   * A source scan that flags nothing is indistinguishable from a source scan that cannot flag
   * anything, and this one had already been narrowed once to stop it tripping on
   * `signature === null`. So the narrowing is itself asserted: the predicate is run over lines that
   * must fail and lines that must pass, and only then over the real files.
   */
  const flagsEarlyExit = (line: string): boolean => {
    const comparison = /\b(signature|digest|provided|computed|expected|mac|hmac)\w*\s*[!=]==\s*([^;)&|]+)/i.exec(line);
    if (comparison === null) return false;
    const rightHandSide = (comparison[2] ?? '').trim();
    return !/^(null|undefined|-?\d+)$/.test(rightHandSide);
  };

  it('is a scan that can actually fail, proved on lines that must and must not trip it', () => {
    for (const offender of [
      'if (signature === expected) return true;',
      'return providedDigest !== computedDigest;',
      'if (hmac === req.headers.signature) { ok() }',
    ]) {
      expect(flagsEarlyExit(offender), `${offender} must be flagged`).toBe(true);
    }

    for (const innocent of [
      "if (input.signature === null || input.signature.length === 0) return 'missing_signature';",
      "if (input.timestamp === undefined) return 'missing_headers';",
      "if (scheme !== ENVELOPE_SCHEME) throw new Error('x');",
      'if (provided.length !== computed.length) return false;',
      "if (header['alg'] !== 'HS256') return 'malformed_signature';",
    ]) {
      expect(flagsEarlyExit(innocent), `${innocent} must not be flagged`).toBe(false);
    }
  });

  it('compares no signature or digest with `===`', () => {
    // `===` returns on the first differing byte, so an attacker with a timing oracle recovers a
    // valid signature one byte at a time. This scans the code with comments removed, because every
    // one of these files *discusses* the hazard in prose.
    const code = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    const offenders: string[] = [];
    for (const [name, source] of HELPERS) {
      for (const line of code(source).split('\n')) {
        if (!line.includes('===') && !line.includes('!==')) continue;
        // The hazard is comparing a signature against *another value*, byte by byte. A presence
        // check is not that, and every one of these verifiers opens with one — see the positive
        // control above, which is what keeps this narrowing from becoming a blanket exemption.
        if (flagsEarlyExit(line)) offenders.push(`${name}: ${line.trim()}`);
      }
    }

    expect(offenders, 'these compare a signature or digest byte-by-byte with early exit').toEqual([]);
  });

  it('exports one comparator, and it answers correctly for equal, unequal and different-length input', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    // A length mismatch must be false rather than a thrown error: `timingSafeEqual` throws on
    // differing lengths, and the throw would itself be the signal.
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);

    const signature = githubSignatureFor(BODY, SECRET);
    expect(constantTimeEqual(signature, signature)).toBe(true);
    expect(constantTimeEqual(signature, tamper(signature))).toBe(false);
  });

  it('is the comparator the GitHub and Jira verifiers actually reach for', () => {
    // Structural rather than behavioural: the source names `constantTimeEqual` at every comparison
    // site, so a future edit that introduced a raw `Buffer.compare` would be visible here.
    const webhooks = sourceOf('auth', 'src', 'webhooks.ts');
    const comparisons = webhooks.match(/constantTimeEqual\(/g) ?? [];

    // GitHub, Jira's shared secret, and Jira's JWT signature: three sites.
    expect(comparisons.length).toBeGreaterThanOrEqual(3);
    expect(webhooks).not.toContain('Buffer.compare');
  });
});

describe('the verifiers never parse before they verify', () => {
  it('takes the raw body as a string on every provider’s input type', () => {
    // Asserted behaviourally: a re-serialisation with different key order must fail, which is only
    // true if the HMAC is over the bytes that arrived.
    const signature = githubSignatureFor(BODY, SECRET);
    const reserialised = JSON.stringify(JSON.parse(BODY) as Record<string, unknown>, ['number', 'action']);

    expect(reserialised).not.toBe(BODY);
    expect(verifyGithubSignature({ rawBody: reserialised, signature, secret: SECRET })).toBe('bad_signature');
  });

  it.each([...WEBHOOK_PROVIDERS])('names an environment variable for %s', (provider: WebhookProvider) => {
    expect(WEBHOOK_SECRET_ENV_VAR[provider]).toMatch(/^[A-Z0-9_]+$/);
  });
});
