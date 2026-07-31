import { describe, expect, it } from 'vitest';

import { allAuthoredSourceFiles, codeWithoutComments, type SourceFile } from './helpers/workspace.js';

/**
 * Two single-owner rules, enforced by scanning the workspace.
 *
 * `alpha-configuration-and-identity-roster-004` asks for both in so many words: *"a test
 * asserts the suppression rule is implemented in exactly one module and the API is the sole
 * write path"*. Neither can be proved by a unit test, because both are claims about
 * *everywhere else* — a second implementation somewhere is exactly what a passing unit test
 * would not see.
 *
 * ## Why they matter
 *
 * **The suppression rule.** At least four detectors could suppress a finding for an absent
 * person: stalled tickets, review waits, changes-requested stalls, stale statuses. Four
 * copies of "is this person out" would drift the moment one learned about a new absence kind
 * or an inclusive end date, and the failure would be silent — a report naming somebody who
 * booked the week off, which is the specific way an automated manager loses its reader.
 *
 * **The Absence write path.** Two producers write absences: a manager on the roster screen
 * and a Manager Memo that said "Priya is out until Thursday". Two independent inserts would
 * mean two shapes of row — one validated, one not; one with a source, one without — and the
 * suppression rule would work for whichever shape its author had in mind.
 */

const SUPPRESSION_MODULE = 'packages/analysis/src/absence-suppression.ts';
const ROSTER_SERVICE = 'packages/knowledge-model/src/roster-service.ts';

/** Source files only — a test that mentions a rule is not an implementation of it. */
const production: readonly SourceFile[] = allAuthoredSourceFiles().filter(
  (file) =>
    !file.relativePath.includes('/tests/') &&
    !file.relativePath.endsWith('.test.ts') &&
    !file.relativePath.endsWith('.test.tsx'),
);

const fileAt = (relativePath: string): SourceFile => {
  const found = production.find((file) => file.relativePath === relativePath);
  if (found === undefined) throw new Error(`${relativePath} is not in the workspace scan.`);
  return found;
};

describe('the stalled-work suppression rule lives in exactly one module', () => {
  it('finds the workspace at all, so an empty scan cannot pass this file', () => {
    expect(production.length).toBeGreaterThan(80);
    expect(production.map((file) => file.relativePath)).toContain(SUPPRESSION_MODULE);
  });

  /**
   * The predicate is "does an absence cover this instant for this person". Any file that
   * compares an absence's bounds against an instant is implementing it.
   */
  it('is the only file that decides whether an absence covers an instant', () => {
    const offenders: string[] = [];

    for (const file of production) {
      if (file.relativePath === SUPPRESSION_MODULE) continue;

      const code = codeWithoutComments(file);

      /**
       * The `absence` entity kind, as a quoted token in code.
       *
       * Not `/absence/i` over the raw text, which was too loose in both directions that
       * matter. `progress.ts` says "Kanban is ... the absence of sprint rows" in a comment and
       * `calibration.ts` puts the word inside a user-facing sentence, and both compare a
       * *sprint's* `startAt`/`endAt` against the instant — so both were reported as
       * implementing a rule about people's leave, which they have nothing to do with. Three
       * standing false positives is how a gate stops being read.
       *
       * Requiring the kind as its own quoted token is the honest test of "this file reads
       * absence rows": that is how an entity kind is spelled everywhere in the model.
       */
      const readsAbsenceEntities = /['"]absence['"]/.test(code);
      const readsBothBounds = /startAt/.test(code) && /endAt/.test(code);
      if (!readsAbsenceEntities || !readsBothBounds) continue;

      // A file that merely stores or renders an absence is not deciding suppression. The
      // decision is a comparison of its bounds against an instant.
      const comparesToInstant =
        /instant\s*[<>]=?\s*[\w.]*(startAt|endAt)/.test(code) ||
        /[\w.]*(startAt|endAt)\s*[<>]=?\s*instant/.test(code) ||
        /\bat\s*>=\s*[\w.]*startAt\b/.test(code);

      if (comparesToInstant) offenders.push(file.relativePath);
    }

    expect(
      offenders,
      `these files decide whether an absence covers an instant. That predicate belongs in ${SUPPRESSION_MODULE} ` +
        'and nowhere else — four copies of it would drift, and the failure would be a report naming somebody who is ' +
        'on leave.',
    ).toEqual([]);
  });

  it('is what the blocker detectors import rather than reimplementing', () => {
    const blockers = fileAt('packages/analysis/src/blockers.ts');

    expect(blockers.text).toContain("from './absence-suppression.js'");
    // And it does not roll its own: no absence bound is read in the detector file.
    expect(blockers.text).not.toMatch(/\bstartAt\b/);
  });

  it('states the rule it implements, so the next reader does not have to infer it', () => {
    const module = fileAt(SUPPRESSION_MODULE);

    expect(module.text).toContain('The only implementation of it');
    // The deduction-versus-suppression distinction is the subtle half and must stay written
    // down: shortening an elapsed count would state a number a manager cannot verify.
    expect(module.text.toLowerCase()).toContain('suppression, not deduction');
  });
});

describe('the roster service is the sole write path for Absence', () => {
  /**
   * An Absence row can only come to exist through `KnowledgeStore.observe` with
   * `kind: 'absence'`. So the rule is checkable exactly: find every file that does that.
   */
  it('is the only file that observes an absence', () => {
    // Also code-only: a route's doc comment quotes `kind: 'absence'` when explaining which
    // module is allowed to write one, and a comment explaining the rule is not a breach of it.
    const offenders = production
      .filter(
        (file) => file.relativePath !== ROSTER_SERVICE && /kind:\s*['"]absence['"]/.test(codeWithoutComments(file)),
      )
      .map((file) => file.relativePath);

    expect(
      offenders,
      'these files write an Absence directly. Every producer — including the Manager Memo path — must call ' +
        `\`recordAbsence\` in ${ROSTER_SERVICE}, so there is one validated shape of row and one place the ` +
        'suppression rule has to understand.',
    ).toEqual([]);
  });

  it('is what the roster provisioning path calls, rather than observing its own', () => {
    // `provisionRoster` accepts declared absences and predates the rule, so it is the
    // caller most likely to have grown its own insert.
    const roster = codeWithoutComments(fileAt('packages/knowledge-model/src/roster.ts'));

    expect(roster).toContain('recordAbsence');
    expect(roster).not.toMatch(/kind:\s*['"]absence['"]/);
  });

  it('validates every absence it writes, so no producer can skip the checks', () => {
    const service = fileAt(ROSTER_SERVICE);

    // The two conditions that would make an absence lie: a range covering no instant, and a
    // memo-sourced absence that cannot be linked back to the memo.
    expect(service.text).toContain('An absence must end after it starts');
    expect(service.text).toContain('An absence from a memo must name the memo');
  });

  it('exports no update or delete path for an absence', () => {
    const service = fileAt(ROSTER_SERVICE);

    for (const forbidden of ['deleteAbsence', 'removeAbsence', 'updateAbsence', 'purgeAbsence']) {
      expect(service.text, `${forbidden} must not exist — an absence is corrected by appending`).not.toContain(
        forbidden,
      );
    }
  });
});

describe('configuration writes append rather than mutate', () => {
  /**
   * The effective-dated guarantee, checked structurally.
   *
   * "A report generated for a past instant resolves team membership and tracked repos as
   * they were effective at that instant" holds only while nothing UPDATEs these rows. The
   * roster service reaches the database exclusively through `store.observe`, which appends a
   * version and never rewrites one — so the absence of any other call *is* the guarantee.
   */
  it('reaches the database only through the append helper', () => {
    // Code, not prose. The module's own doc comment promises there is no `db.update()`
    // reachable from it, and scanning raw text made that promise the thing that failed the
    // gate — the better the rule was documented, the redder the build.
    const code = codeWithoutComments(fileAt(ROSTER_SERVICE));

    for (const forbidden of ['updateIn(', 'deleteFrom(', '.update(', '.delete(']) {
      expect(
        code,
        `${forbidden} in the roster service would break "a past report resolves the configuration in force then"`,
      ).not.toContain(forbidden);
    }
    expect(code).toContain('store.observe(');
  });

  it('says why, so the next person to add a write knows the rule before they break it', () => {
    expect(fileAt(ROSTER_SERVICE).text).toContain('There is deliberately **no update**');
  });
});
