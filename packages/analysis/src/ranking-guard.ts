import { compareStable } from './instant.js';

/**
 * The no-individual-ranking guard.
 *
 * Compass will not rank people. Not as a policy statement in a document — as a
 * function that walks the output and throws.
 *
 * The reason is that this is the single easiest way for a tool like this to do
 * harm, and the failure is gradual rather than dramatic. Nobody sets out to build
 * a leaderboard. Someone adds a per-developer commit count "just for the debt
 * signal", someone sorts a list by it because sorted lists look tidier, and six
 * months later a manager is running a performance review off a page that was
 * supposed to help them unblock people. Every step in that sequence is
 * reasonable. So the guard blocks the first one.
 *
 * Two families of violation are detected:
 *
 *  1. **A banned concept, by field name.** A field called `commitCount`,
 *     `linesChanged`, `productivityScore`, `rank` or `topPerformers` cannot be
 *     made acceptable by context, so the name itself is refused wherever it
 *     appears in an analysis output.
 *  2. **A per-person list ordered by a number.** An array whose elements are each
 *     *about* a developer must be ordered by `developerKey`, ascending. Ordering
 *     it by a magnitude is what turns a distribution into a ranking, and it is
 *     invisible in a type — only the values show it.
 *
 * A row is "about a developer" when it carries a `developerKey` and does not
 * carry an artifact key (`pullRequestKey`, `ticketKey`, `sprintKey`). That
 * distinction matters: the review queue is a list of *pull requests*, legitimately
 * ordered oldest-first, and each row happens to mention its author. It is not a
 * list of people.
 */

/**
 * Field names that may not appear anywhere in an analysis output.
 *
 * Each pattern is anchored to whole words in camelCase or snake_case so
 * `rankingGuard` itself would not trip it, and so `workingDaysWaiting` is not
 * mistaken for a productivity metric.
 */
export const BANNED_OUTPUT_FIELD_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] =
  Object.freeze([
    { pattern: /^(rank|ranking|rankings|ranked.*)$/i, why: 'a rank is a ranking' },
    { pattern: /leaderboard/i, why: 'a leaderboard ranks people' },
    { pattern: /(top|bottom|best|worst)[_-]?(performer|performers|contributor|contributors|developer|developers)/i, why: 'naming a best or worst person is a ranking' },
    { pattern: /(most|least)[_-]?(active|productive)/i, why: 'activity comparisons between people are rankings' },
    { pattern: /^commit(s)?[_-]?count$/i, why: 'commit counts measure typing, not contribution' },
    { pattern: /^(commits|commitCount)Per(Developer|Person|Author)$/i, why: 'per-person commit counts are a productivity metric' },
    { pattern: /lines?[_-]?of[_-]?code/i, why: 'lines of code is not a measure of anything' },
    { pattern: /^(loc|sloc)([_-]?(added|removed|changed|total))?$/i, why: 'lines of code is not a measure of anything' },
    { pattern: /lines[_-]?(added|removed|changed)/i, why: 'lines changed is not a measure of anything' },
    { pattern: /productivity/i, why: 'productivity scores rank people' },
    { pattern: /(velocity|throughput|output)[_-]?(per|by)[_-]?(developer|person|author)/i, why: 'per-person throughput is a ranking' },
    { pattern: /performance[_-]?(score|rating|index)/i, why: 'a performance score ranks people' },
  ]);

/** Properties that identify a row as being *about a person*. */
const PERSON_KEY_FIELDS = ['developerKey'] as const;

/** Properties that identify a row as being about an artifact instead. */
const ARTIFACT_KEY_FIELDS = [
  'pullRequestKey',
  'pullRequestNumber',
  'ticketKey',
  'sprintKey',
  'unitOfWork',
  'commitKey',
  'releaseKey',
] as const;

/** Numeric properties whose presence makes an ordering meaningful. */
const isNumeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export interface RankingViolation {
  /** JSON path, e.g. `$.findings.workload.perDeveloper[2].commitCount`. */
  readonly path: string;
  readonly kind: 'banned_field' | 'person_list_ordered_by_magnitude';
  readonly detail: string;
}

export class IndividualRankingError extends Error {
  readonly violations: readonly RankingViolation[];

  constructor(violations: readonly RankingViolation[]) {
    super(
      `This analysis output ranks individuals, which Compass does not do:\n${violations
        .map((violation) => `  - ${violation.path}: ${violation.detail}`)
        .join('\n')}`,
    );
    this.name = 'IndividualRankingError';
    this.violations = violations;
  }
}

/**
 * Walks any analysis output and returns every ranking violation found.
 *
 * Exported separately from `assertNoIndividualRanking` so a test can assert the
 * detector actually detects — a guard nobody has seen fail is a guard nobody
 * knows works.
 */
export function findIndividualRankingViolations(value: unknown, path = '$'): readonly RankingViolation[] {
  const violations: RankingViolation[] = [];

  const walk = (current: unknown, currentPath: string): void => {
    if (Array.isArray(current)) {
      checkPersonList(current, currentPath, violations);
      current.forEach((entry, index) => walk(entry, `${currentPath}[${index}]`));
      return;
    }
    if (current === null || typeof current !== 'object') return;

    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      const banned = BANNED_OUTPUT_FIELD_PATTERNS.find((candidate) => candidate.pattern.test(key));
      if (banned !== undefined) {
        violations.push({
          path: `${currentPath}.${key}`,
          kind: 'banned_field',
          detail: `\`${key}\` is a banned output field — ${banned.why}.`,
        });
      }
      walk(nested, `${currentPath}.${key}`);
    }
  };

  walk(value, path);
  return violations;
}

function checkPersonList(entries: readonly unknown[], path: string, violations: RankingViolation[]): void {
  if (entries.length < 2) return;

  const rows = entries.filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
  if (rows.length !== entries.length) return;

  const personField = PERSON_KEY_FIELDS.find((field) => rows.every((row) => typeof row[field] === 'string'));
  if (personField === undefined) return;
  if (ARTIFACT_KEY_FIELDS.some((field) => rows.some((row) => row[field] !== undefined))) return;

  // A per-person list with no numbers in it cannot be a ranking.
  const hasMagnitude = rows.some((row) =>
    Object.entries(row).some(([key, value]) => key !== personField && isNumeric(value)),
  );
  if (!hasMagnitude) return;

  const keys = rows.map((row) => String(row[personField]));
  const sorted = [...keys].sort(compareStable);
  if (keys.every((key, index) => key === sorted[index])) return;

  violations.push({
    path,
    kind: 'person_list_ordered_by_magnitude',
    detail: `this list is about people (each row has \`${personField}\`) and carries numbers, so it must be ordered by \`${personField}\` ascending — found ${JSON.stringify(keys.slice(0, 4))}. Ordering people by a number is a leaderboard.`,
  });
}

/**
 * Fails closed on any ranking violation.
 *
 * Called by `generateStructuredReport` before it returns, so a ranking construct
 * introduced anywhere in the analysis core surfaces as a thrown error at the
 * boundary rather than as a section in somebody's morning email.
 */
export function assertNoIndividualRanking(value: unknown): void {
  const violations = findIndividualRankingViolations(value);
  if (violations.length > 0) throw new IndividualRankingError(violations);
}
