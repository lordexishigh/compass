import { RuleTester } from 'eslint';
import { describe, it, expect } from 'vitest';

import noSystemClock from '../rules/no-system-clock.js';
import noTimeLibraryImports from '../rules/no-time-library-imports.js';
import noClockInstantiation from '../rules/no-clock-instantiation.js';
import noAnalysisIo from '../rules/no-analysis-io.js';
import plugin from '../index.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
});

describe('the plugin surface', () => {
  it('exports exactly the five build gates', () => {
    expect(Object.keys(plugin.rules).sort()).toEqual([
      'no-analysis-io',
      'no-clock-instantiation',
      // `beta-security-hardening`: no credential in a log line or a response body, anywhere in
      // the workspace. Its behaviour is asserted through the real workspace ESLint in
      // `tools/quality-gates/tests/security-posture.test.ts` rather than with a RuleTester here,
      // because the claim that matters is the *wiring* — a rule registered against the wrong glob
      // passes every RuleTester and protects nothing.
      'no-secret-disclosure',
      'no-system-clock',
      'no-time-library-imports',
    ]);
  });
});

ruleTester.run('no-system-clock', noSystemClock, {
  valid: [
    // Pure conversions of a value that already came from the Clock port.
    { code: 'const d = new Date(instant);' },
    { code: 'const ms = Date.parse("2026-07-30T08:00:00Z");' },
    { code: 'const utc = Date.UTC(2026, 6, 30);' },
    { code: 'const iso = new Date(toEpochMillis(now)).toISOString();' },
    { code: 'function report(now) { return now; }' },
    // Same identifier, different object.
    { code: 'const value = clock.now();' },
    { code: 'const { now } = context;' },
  ],
  invalid: [
    {
      code: 'const t = new Date();',
      errors: [{ messageId: 'forbidden', data: { expression: 'new Date()' } }],
    },
    {
      code: 'const t = new Date;',
      errors: [{ messageId: 'forbidden' }],
    },
    {
      // The parenthesised form a regex-based check misses.
      code: 'const t = new (Date)();',
      errors: [{ messageId: 'forbidden' }],
    },
    {
      code: 'const t = Date.now();',
      errors: [{ messageId: 'forbidden', data: { expression: 'Date.now' } }],
    },
    {
      // Computed member access — also invisible to a grep for `Date.now(`.
      code: "const t = Date['now']();",
      errors: [{ messageId: 'forbidden' }],
    },
    {
      // Destructured off the constructor.
      code: 'const { now } = Date; const t = now();',
      errors: [{ messageId: 'forbidden' }],
    },
    {
      code: 'const t = performance.now();',
      errors: [{ messageId: 'forbidden' }],
    },
    {
      code: 'const t = process.hrtime();',
      errors: [{ messageId: 'forbidden' }],
    },
  ],
});

ruleTester.run('no-time-library-imports', noTimeLibraryImports, {
  valid: [
    { code: "import { instantFromIso } from '@compass/clock';" },
    { code: "import { z } from 'zod';" },
    { code: "import base from 'date-fns-like-but-not';" },
  ],
  invalid: [
    { code: "import dayjs from 'dayjs';", errors: [{ messageId: 'forbidden' }] },
    { code: "import utc from 'dayjs/plugin/utc';", errors: [{ messageId: 'forbidden' }] },
    { code: "import { DateTime } from 'luxon';", errors: [{ messageId: 'forbidden' }] },
    { code: "import { addDays } from 'date-fns';", errors: [{ messageId: 'forbidden' }] },
    { code: "const { performance } = require('node:perf_hooks');", errors: [{ messageId: 'forbidden' }] },
    { code: "const m = await import('moment');", errors: [{ messageId: 'forbidden' }] },
  ],
});

ruleTester.run('no-clock-instantiation', noClockInstantiation, {
  valid: [
    { code: 'export function ingestWindow(request, now) { return now; }' },
    { code: 'const now = context.now;' },
    { code: 'const c = new SomeOtherThing();' },
  ],
  invalid: [
    { code: 'const clock = new SystemClock();', errors: [{ messageId: 'forbidden' }] },
    { code: 'const clock = new FixedClock(instant);', errors: [{ messageId: 'forbidden' }] },
    { code: 'const clock = createSystemClock();', errors: [{ messageId: 'forbidden' }] },
  ],
});

ruleTester.run('no-analysis-io', noAnalysisIo, {
  valid: [
    // Relative imports inside the package are the only imports it has.
    { code: "import { compareStable } from './instant.js';" },
    { code: "export { assessProgress } from './progress.js';" },
    { code: "export * from './snapshot.js';" },
    // Not the banned names, only near them.
    { code: "import { pathToKey } from './pathing.js';" },
    { code: "import cryptic from './cryptic.js';" },
    // Sorting, arithmetic and comparison are the whole job.
    { code: 'const ordered = [3, 1].sort((a, b) => a - b);' },
    { code: 'const share = Math.round((3 / 4) * 100);' },
    { code: 'const later = Math.max(a, b);' },
  ],
  invalid: [
    {
      code: "import { readFileSync } from 'node:fs';",
      errors: [
        {
          messageId: 'forbiddenImport',
          data: { module: 'node:fs', reason: 'the analysis core performs no I/O and reads no host state' },
        },
      ],
    },
    { code: "import { readFileSync } from 'fs';", errors: [{ messageId: 'forbiddenImport' }] },
    { code: "import { createServer } from 'node:http';", errors: [{ messageId: 'forbiddenImport' }] },
    { code: "import { createHash } from 'node:crypto';", errors: [{ messageId: 'forbiddenImport' }] },
    {
      code: "import { instantFromIso } from '@compass/clock';",
      errors: [
        {
          messageId: 'forbiddenImport',
          data: {
            module: '@compass/clock',
            reason: 'the analysis core declares no dependencies, so every layer boundary stays a package boundary',
          },
        },
      ],
    },
    { code: "import { KnowledgeStore } from '@compass/knowledge-model';", errors: [{ messageId: 'forbiddenImport' }] },
    { code: "import { scopedDb } from '@compass/db';", errors: [{ messageId: 'forbiddenImport' }] },
    { code: "import { drizzle } from 'drizzle-orm/node-postgres';", errors: [{ messageId: 'forbiddenImport' }] },
    { code: "export { thing } from 'node:path';", errors: [{ messageId: 'forbiddenImport' }] },
    { code: "const fs = await import('node:fs');", errors: [{ messageId: 'forbiddenImport' }] },
    { code: "const fs = require('node:fs');", errors: [{ messageId: 'forbiddenImport' }] },
    {
      code: 'const jitter = Math.random();',
      errors: [{ messageId: 'forbiddenExpression', data: { expression: 'Math.random' } }],
    },
    { code: 'const id = crypto.randomUUID();', errors: [{ messageId: 'forbiddenExpression' }] },
    { code: "const response = fetch('https://example.test');", errors: [{ messageId: 'forbiddenExpression' }] },
    { code: 'const f = globalThis.fetch;', errors: [{ messageId: 'forbiddenExpression' }] },
  ],
});
