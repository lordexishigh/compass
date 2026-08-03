import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MASTER_KEY_ENV_VAR,
  RATE_LIMIT_POLICIES,
  ROLE_MATRIX,
  WEBHOOK_PROVIDERS,
  WEBHOOK_SECRET_ENV_VAR,
  WEBHOOK_TIMESTAMP_WINDOW_SECONDS,
  isPublicRoute,
} from '@compass/auth';
import { describe, expect, it } from 'vitest';

import { isRuleEnabledFor, lintFiles, lintVirtualSource } from './helpers/lint.js';
import { REPO_ROOT, allAuthoredSourceFiles } from './helpers/workspace.js';

/**
 * The security posture, as a build gate.
 *
 * Two jobs, and they are the two the acceptance criteria name that no unit test can do:
 *
 *  1. **The documentation is the specification.** `docs/ENGINEERING.md` quotes every header value,
 *     every rate limit and the whole public-route set. This diffs the prose against the constants,
 *     so the two cannot drift — a limit changed in code and not in the doc fails the build, and so
 *     does the reverse.
 *  2. **The secret-disclosure rule is wired and works.** A rule that is perfect and registered
 *     against the wrong glob passes every RuleTester and protects nothing, so this asks the real
 *     workspace ESLint what it would do to code containing a token in a log line.
 */

const readDoc = (name: string): string => readFileSync(join(REPO_ROOT, 'docs', name), 'utf8');
const ENGINEERING = readDoc('ENGINEERING.md');

/** The header values, from the one module that owns them. Read as source, not imported. */
const SECURITY_HEADERS_SOURCE = readFileSync(
  join(REPO_ROOT, 'apps', 'web', 'lib', 'security-headers.ts'),
  'utf8',
);

describe('the documented header values are the enforced ones', () => {
  /**
   * Pulled out of the module's own object literal rather than imported.
   *
   * `apps/web/lib/security-headers.ts` uses `crypto.getRandomValues` and is written for the Edge
   * runtime; importing it into a Node quality gate would work today and is the kind of coupling
   * that breaks when the module gains a Next import. Reading the literal keeps this gate a *text*
   * comparison in both directions, which is all it needs to be.
   */
  const headerValues = new Map<string, string>();
  for (const match of SECURITY_HEADERS_SOURCE.matchAll(/^\s*'([a-z-]+)':\s*'([^']+)',$/gm)) {
    headerValues.set(match[1]!, match[2]!);
  }

  it('found the header table in the source at all', () => {
    expect(headerValues.size, 'the static header constant could not be read').toBeGreaterThanOrEqual(5);
    expect([...headerValues.keys()].sort()).toEqual([
      'permissions-policy',
      'referrer-policy',
      'strict-transport-security',
      'x-content-type-options',
      'x-frame-options',
    ]);
  });

  it.each([
    ['strict-transport-security'],
    ['x-content-type-options'],
    ['referrer-policy'],
    ['permissions-policy'],
    ['x-frame-options'],
  ])('documents %s with the value the code sets', (header) => {
    const value = headerValues.get(header)!;

    expect(
      ENGINEERING,
      `docs/ENGINEERING.md must quote \`${value}\` for ${header} — it is what middleware sets`,
    ).toContain(value);
  });

  it('documents the CSP’s two load-bearing claims', () => {
    expect(SECURITY_HEADERS_SOURCE).toContain("frame-ancestors 'none'");
    expect(ENGINEERING).toContain("frame-ancestors 'none'");

    // No `unsafe-inline` in script-src, in the code and in the prose.
    const scriptSrc = /script-src[^"']*/.exec(SECURITY_HEADERS_SOURCE)?.[0] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(ENGINEERING).toContain('no `unsafe-inline` in `script-src`');
  });

  it('states the one relaxation rather than quietly keeping it', () => {
    // `style-src` does keep `unsafe-inline`. Honest degradation over confident polish applies to
    // the security posture too: a limitation the documentation hides is worse than the limitation.
    expect(SECURITY_HEADERS_SOURCE).toMatch(/style-src[^;]*unsafe-inline/);
    expect(ENGINEERING).toContain("`style-src` keeps `'unsafe-inline'`");
  });

  it('names middleware as the single owner, and next.config.ts as owning none', () => {
    const nextConfig = readFileSync(join(REPO_ROOT, 'apps', 'web', 'next.config.ts'), 'utf8');
    const code = nextConfig.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    expect(code, 'a header declared in two places is emitted twice').not.toContain('headers()');
    expect(ENGINEERING).toContain('`next.config.ts` deliberately declares no `headers()`');
  });
});

describe('the documented rate limits are the enforced ones', () => {
  it.each(Object.values(RATE_LIMIT_POLICIES).map((policy) => [policy.action, policy] as const))(
    'documents %s’s threshold and window',
    (_action, policy) => {
      const perWindow =
        policy.windowMillis === 60_000
          ? 'per minute'
          : policy.windowMillis === 3_600_000
            ? 'per hour'
            : `per ${policy.windowMillis / 60_000} minutes`;

      expect(
        ENGINEERING,
        `docs/ENGINEERING.md must state "${policy.limit} ${perWindow}" for ${policy.action}`,
      ).toContain(`${policy.limit} ${perWindow}`);
    },
  );

  it('documents every subject each limit is counted against', () => {
    // A limit counted per token rather than per IP is a different control with different
    // properties, so the subject is part of the specification and not an implementation detail.
    for (const policy of Object.values(RATE_LIMIT_POLICIES)) {
      for (const subject of policy.subjects) {
        expect(
          ENGINEERING.toLowerCase(),
          `${policy.action} is counted per ${subject}, which the documentation must say`,
        ).toContain(subject);
      }
    }
  });

  it('documents the 429, the Retry-After and the exponential lockout', () => {
    expect(ENGINEERING).toContain('429');
    expect(ENGINEERING).toContain('Retry-After');
    expect(ENGINEERING).toContain('1, 2, 4, 8, 16');
    expect(ENGINEERING).toContain('capped at one hour');
  });

  it('documents the in-process limitation, which is the one an operator needs', () => {
    // Two replicas would each grant the full allowance. A reader of the numbers has to read this
    // in the same breath, or the numbers are a promise the deployment does not keep.
    expect(ENGINEERING).toContain('in this process');
    expect(ENGINEERING).toContain('shared store');
  });
});

describe('the documented public-route set is the matrix’s', () => {
  const publicRoutes = ROLE_MATRIX.filter(isPublicRoute).map((rule) => rule.route);

  it('found public routes to check, so an empty set cannot pass', () => {
    expect(publicRoutes.length).toBeGreaterThan(10);
  });

  it.each(publicRoutes.map((route) => [route]))('documents %s as public', (route) => {
    // Backticked in the prose, so `/api/goals` cannot be satisfied by `/api/goals/[nodeId]`.
    expect(ENGINEERING, `${route} is public in ROLE_MATRIX but is not in docs/ENGINEERING.md`).toContain(
      `\`${route}\``,
    );
  });

  it('documents that `public` is explicit and never inferred', () => {
    expect(ENGINEERING).toContain('never a default and');
    expect(ENGINEERING).toContain('never inferred');
  });

  it('names no route as public in the prose that the matrix does not grant', () => {
    /**
     * The other direction, and the one that matters more: documentation claiming a route is public
     * when it is not would be read as permission to widen it.
     *
     * Scoped to the public-routes section, because backticked route paths appear all over this
     * document for other reasons.
     */
    const section = /### Public routes([\s\S]*?)\n### /.exec(ENGINEERING)?.[1] ?? '';
    expect(section.length, 'the public-routes section could not be found').toBeGreaterThan(200);

    const claimed = new Set([...section.matchAll(/`(\/[a-z0-9[\]/-]*)`/gi)].map((match) => match[1]!));
    const granted = new Set(publicRoutes);
    const overclaimed = [...claimed].filter((route) => !granted.has(route));

    expect(overclaimed, 'the documentation calls these public but the matrix does not').toEqual([]);
  });
});

describe('the documented webhook verification is the implemented one', () => {
  it.each([...WEBHOOK_PROVIDERS].map((provider) => [provider]))('documents %s and its secret', (provider) => {
    expect(ENGINEERING).toContain(provider);
    expect(
      ENGINEERING,
      `the operator has to know which variable holds ${provider}'s secret`,
    ).toContain(WEBHOOK_SECRET_ENV_VAR[provider]);
  });

  it('documents the replay window as the code enforces it', () => {
    expect(WEBHOOK_TIMESTAMP_WINDOW_SECONDS).toBe(300);
    expect(ENGINEERING).toContain('5-minute');
    expect(ENGINEERING).toContain('401');
  });

  it('documents that a verified delivery is acknowledged and not ingested', () => {
    // The honest statement. A doc implying the payload was read would make the freshness line a lie.
    expect(ENGINEERING).toContain('202');
    expect(ENGINEERING).toContain('hint');
  });

  it('documents the constant-time comparison by name', () => {
    expect(ENGINEERING).toContain('timingSafeEqual');
    expect(ENGINEERING).toContain('constantTimeEqual');
  });
});

describe('the documented token encryption is the implemented one', () => {
  it('names the master-key variable the code actually reads', () => {
    expect(MASTER_KEY_ENV_VAR).toBe('COMPASS_KMS_MASTER_KEY');
    expect(ENGINEERING).toContain(MASTER_KEY_ENV_VAR);
  });

  it('documents that no API returns a token, masked or otherwise', () => {
    expect(ENGINEERING).toContain('masked or otherwise');
  });

  it('documents the two rotations and their different costs', () => {
    expect(ENGINEERING).toContain('rewrapOrganizationDataKey');
    expect(ENGINEERING).toContain('rotateOrganizationDataKey');
  });
});

// ---------------------------------------------------------------------------
// The secret-leak check, asserted through the real workspace ESLint
// ---------------------------------------------------------------------------

describe('compass/no-secret-disclosure is wired into the build', () => {
  it('is an error everywhere, not only in one layer', async () => {
    // A credential in a worker log is exactly as shipped and indexed as one in a route response,
    // so unlike the clock and purity rules this one is not scoped to a path list.
    for (const file of [
      'apps/web/app/api/health/route.ts',
      'apps/web/lib/rate-limit.ts',
      'packages/auth/src/integration-tokens.ts',
      'packages/ingest/src/index.ts',
      'apps/worker/src/index.ts',
      'tools/smoke/src/probe.ts',
    ]) {
      expect(
        await isRuleEnabledFor(file, 'compass/no-secret-disclosure'),
        `${file} is not covered by the secret-disclosure gate`,
      ).toBe(true);
    }
  });

  it('fails a token in a log statement', async () => {
    const violations = await lintVirtualSource(
      'apps/web/lib/probe-log.ts',
      [
        'export function connect(config: { accessToken: string }) {',
        '  console.info(`[compass] connecting`, { accessToken: config.accessToken });',
        '}',
      ].join('\n'),
    );

    const disclosure = violations.filter((violation) => violation.ruleId === 'compass/no-secret-disclosure');
    expect(disclosure.length, 'a token in a log line must fail the build').toBeGreaterThan(0);
    expect(disclosure[0]?.message).toContain('log');
  });

  it('fails a bare credential interpolated into a log line', async () => {
    const violations = await lintVirtualSource(
      'apps/worker/src/probe-log.ts',
      ['export function trace(refreshToken: string) {', '  console.warn(`refreshing with ${refreshToken}`);', '}'].join(
        '\n',
      ),
    );

    expect(violations.some((violation) => violation.ruleId === 'compass/no-secret-disclosure')).toBe(true);
  });

  it('fails a token in a response body, however deeply nested', async () => {
    const violations = await lintVirtualSource(
      'apps/web/app/api/probe/route.ts',
      [
        "import { NextResponse } from 'next/server';",
        'export function GET() {',
        '  return NextResponse.json({ source: { key: 1, credentials: { access_token: "x" } } });',
        '}',
      ].join('\n'),
    );

    const disclosure = violations.filter((violation) => violation.ruleId === 'compass/no-secret-disclosure');
    expect(disclosure.length, 'a nested token in a response must fail the build').toBeGreaterThan(0);
    expect(disclosure[0]?.message).toContain('masked or otherwise');
  });

  it('fails a *masked* token just as hard as a plaintext one', async () => {
    // The failure this rule exists for. A mask reads as responsible and still confirms existence,
    // length and provider prefix — which is most of what an attacker enumerating an integration
    // wants — so there is no allowance for it.
    const violations = await lintVirtualSource(
      'apps/web/app/api/probe/route.ts',
      [
        'import { jsonOk } from "../../../lib/auth/http";',
        'export function GET() {',
        '  return jsonOk({ accessToken: "ghp_****" + "abcd" });',
        '}',
      ].join('\n'),
    );

    expect(violations.some((violation) => violation.ruleId === 'compass/no-secret-disclosure')).toBe(true);
  });

  it('permits the safe forms, or it would ban the pattern it is protecting', async () => {
    /**
     * Every one of these is legitimate and has to stay legitimate:
     *
     *  - a **digest** is the storage form of a bearer secret, and Compass stores digests precisely
     *    so a leaked row is not a leaked credential;
     *  - **ciphertext** is not a disclosure, and the envelope's AAD means it does not open elsewhere;
     *  - **metadata** — presence, kind, expiry — is what the API returns *instead of* the secret;
     *  - a **request** body carrying a password is how a password is ever checked.
     */
    const violations = await lintVirtualSource(
      'apps/web/app/api/probe/route.ts',
      [
        "import { NextResponse } from 'next/server';",
        'export async function GET(request: Request) {',
        '  await fetch("https://compass.invalid", { body: JSON.stringify({ email: "a", password: "b" }) });',
        '  console.info(`[compass] session`, { tokenHash: "abc", tokenDigest: "def" });',
        '  return NextResponse.json({',
        '    present: true,',
        '    tokenKind: "access",',
        '    keyVersion: 2,',
        '    expiresAt: null,',
        '    sealedValue: "v1:aes-256-gcm.a.b.c",',
        '    wrappedDataKey: "v1:aes-256-gcm.d.e.f",',
        '    hasPassword: true,',
        '  });',
        '}',
      ].join('\n'),
    );

    expect(
      violations.filter((violation) => violation.ruleId === 'compass/no-secret-disclosure'),
      'the rule must not ban the safe forms',
    ).toEqual([]);
  });

  it('finds no disclosure anywhere in the workspace as it stands', async () => {
    // The gate doing its actual job, over the real tree rather than a fixture.
    const violations = await lintFiles([
      'apps/web/app/**/*.ts',
      'apps/web/lib/**/*.ts',
      'apps/worker/src/**/*.ts',
      'packages/*/src/**/*.ts',
    ]);

    expect(
      violations.filter((violation) => violation.ruleId === 'compass/no-secret-disclosure'),
      'a credential is being logged or returned somewhere in the workspace',
    ).toEqual([]);
  });

  it('has no disable comment anywhere, so the gate cannot be locally switched off', () => {
    /**
     * The clock gate is allowed exactly one documented exemption and asserts that there is exactly
     * one. This gate has none, and that asymmetry is deliberate: `SystemClock` has to read the clock
     * somewhere, so the exemption is real and is pinned to one line — whereas there is no place in
     * Compass that legitimately logs or returns a credential, so there is no escape hatch for the
     * next person to find and copy.
     *
     * `allAuthoredSourceFiles()` excludes `tools/quality-gates` itself, which it has to: the tests
     * above quote the rule name as data, and a census that counted them would report itself.
     */
    const offenders = allAuthoredSourceFiles()
      .filter((file) => file.text.includes('no-secret-disclosure') && file.text.includes('eslint-disable'))
      .map((file) => file.relativePath);

    expect(offenders, 'these files disable the secret-disclosure gate').toEqual([]);
  });
});
