import { GOLDEN_DAY_COUNT, goldenDays, renderFixture } from './index.js';

/**
 * Prints one report's canonical JSON to stdout. The separate-process half of the
 * determinism gate.
 *
 * ## Why a second process proves something the first cannot
 *
 * Generating a report twice inside one process shows that the code does not mutate
 * its own inputs. It cannot show that the report is independent of the *host*, because
 * both runs share one module registry, one ICU build, one locale, one timezone and one
 * V8 instance. Anything cached at module load — a `Map` keyed on something incidental,
 * a lazily built lookup table, an `Intl` collator created once — is identical in both
 * runs by construction, and a report that depended on it would pass an in-process
 * check and still differ between two machines.
 *
 * So this exists to be spawned: `tests/determinism.test.ts` runs it twice, and runs it
 * again under a different `TZ` and locale, and requires byte-identical output every
 * time. That is the assertion that makes "the same (org, team, instant) produces the
 * same report" a property of the product rather than of one process.
 *
 * Usage: `tsx src/generate-one.ts <scope> <dayOffset>`, where `scope` is a team key or
 * `merged`, and `dayOffset` indexes the ten-day sequence.
 */
const [scope, rawOffset] = process.argv.slice(2);

if (scope === undefined || rawOffset === undefined) {
  throw new Error('Usage: generate-one.ts <team|merged> <dayOffset>');
}

const dayOffset = Number.parseInt(rawOffset, 10);
if (!Number.isInteger(dayOffset) || dayOffset < 0 || dayOffset >= GOLDEN_DAY_COUNT) {
  throw new Error(`dayOffset must be an integer in [0, ${GOLDEN_DAY_COUNT}); received \`${rawOffset}\`.`);
}

const day = goldenDays()[dayOffset];
if (day === undefined) throw new Error(`No day at offset ${dayOffset}.`);

// `stdout.write` rather than `console.info`: this output is data a test compares byte
// for byte, and a trailing newline added by a logger would be part of the comparison.
process.stdout.write(renderFixture(scope, day));
