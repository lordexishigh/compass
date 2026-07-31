import { RuleTester } from 'eslint';
import { describe, it, expect } from 'vitest';

import noSystemClock from '../rules/no-system-clock.js';
import noTimeLibraryImports from '../rules/no-time-library-imports.js';
import noClockInstantiation from '../rules/no-clock-instantiation.js';
import plugin from '../index.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
});

describe('the plugin surface', () => {
  it('exports exactly the three build gates', () => {
    expect(Object.keys(plugin.rules).sort()).toEqual([
      'no-clock-instantiation',
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
