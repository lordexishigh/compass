import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTOMATED_DECISIONS,
  DPIA,
  NO_RANKING_STANCE,
  POLICY_DOCUMENTS,
  PRIVACY_POLICY,
  SUBPROCESSORS,
  SUBPROCESSOR_NOTICE_DAYS,
  TERMS,
  TRUST_CONTACT,
  describeSubprocessorChanges,
  subprocessorDigest,
  type PolicyDocument,
} from '../src/index.js';

/**
 * The published commitments, asserted against what the product actually does.
 *
 * ## Why prose gets a test suite
 *
 * Three acceptance criteria are about specific sentences being present and true: the Article 22 statement
 * must say alignment flags are advisory, manager-correctable and not routed to HR systems; the no-ranking
 * stance must point at the guard that enforces it; and the subprocessor list must be the same list the
 * 30-day notice job diffs.
 *
 * None of those would fail a build if the sentence were softened or the guard deleted. A policy page is the
 * one artifact in a codebase that keeps rendering perfectly after it stops being true, and the reader who
 * finds out is a regulator rather than a developer. So the claims are checked here, and the checks that
 * matter most are the ones that reach *outside* this package — asserting that the files the stance names
 * still exist, and that the ranking guard it credits is still called where it says it is called.
 *
 * ## What this suite deliberately does not do
 *
 * It does not assert exact wording. A lawyer must be able to re-word any of this without a red build, so
 * the assertions are on the load-bearing claims (the four hedges, the named files, the notice window) and
 * not on sentences.
 */

/** Repo root, from `packages/trust/tests`. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Every paragraph and bullet of a document, flattened, for a claim search. */
const textOf = (document: PolicyDocument): string =>
  document.sections
    .flatMap((section) => [section.heading, ...section.paragraphs, ...(section.bullets ?? [])])
    .join('\n');

describe('the Article 22 statement makes the claims the criterion requires', () => {
  const text = textOf(AUTOMATED_DECISIONS);

  it('states that no automated decision with legal or significant effect is produced', () => {
    expect(AUTOMATED_DECISIONS.lede.toLowerCase()).toContain('no automated decision');
    expect(text).toMatch(/Article 22 is not engaged/);
    // The specific decisions disclaimed, because "no significant decision" is a conclusion and these are
    // the facts underneath it.
    for (const decision of ['pay', 'promotion', 'disciplinary', 'hiring', 'termination']) {
      expect(text.toLowerCase(), `the statement does not disclaim deciding ${decision}`).toContain(decision);
    }
  });

  it('hedges alignment flags as advisory, correctable, evidenced and never routed to HR', () => {
    /**
     * The four load-bearing hedges.
     *
     * These are the sentences a data protection officer reads to decide whether Article 22 is engaged, and
     * they are the reason the answer is no. Softening any one of them changes the legal position, so each
     * is asserted separately and named in its own failure.
     */
    const claims: ReadonlyArray<readonly [string, RegExp]> = [
      ['advisory', /Advisory\./],
      ['manager-correctable', /Manager-correctable\./],
      ['evidenced rather than asserted', /Evidenced, never asserted\./],
      ['never routed to HR systems', /Never routed to HR systems\./],
    ];

    for (const [claim, pattern] of claims) {
      expect(pattern.test(text), `the Article 22 statement no longer claims flags are ${claim}`).toBe(true);
    }

    // And the substance behind the HR claim, which is the one a buyer tests: no integration, no export.
    expect(text).toMatch(/no integration with any HR, payroll, performance or identity-management system/);
    expect(text).toMatch(/there is no export designed to feed one/);
  });

  it('offers a route to object and points at the self-serve page', () => {
    expect(text).toMatch(/without a manager’s approval/);
    expect(text).toContain('What Compass says about you');
  });
});

describe('the no-individual-ranking stance is anchored to the code that enforces it', () => {
  const text = textOf(NO_RANKING_STANCE);

  it('names the guard, its call site and the test, and all three still exist', () => {
    /**
     * The strongest assertion in this file.
     *
     * The stance's whole claim is that the promise is "enforced by a guard in code, not by a promise on a
     * page". A published page naming a deleted file is worse than a page that names nothing: it invites a
     * reader to verify, and the verification fails. So the paths are read out of the prose and stat'ed.
     */
    const named = [
      'packages/analysis/src/ranking-guard.ts',
      'packages/analysis/src/generate.ts',
      'packages/analysis/tests/determinism.test.ts',
    ];

    for (const path of named) {
      expect(text, `the stance no longer names ${path}`).toContain(path);
      expect(
        existsSync(join(REPO_ROOT, path)),
        `the stance names ${path}, which does not exist — the published page points at nothing`,
      ).toBe(true);
    }
  });

  it('names a guard function that is still exported and still called before publication', () => {
    expect(text).toContain('assertNoIndividualRanking');

    const guard = readFileSync(join(REPO_ROOT, 'packages/analysis/src/ranking-guard.ts'), 'utf8');
    const callSite = readFileSync(join(REPO_ROOT, 'packages/analysis/src/generate.ts'), 'utf8');

    // Exported under the name the page gives it...
    expect(guard, 'ranking-guard.ts no longer exports assertNoIndividualRanking under that name').toMatch(
      /export function assertNoIndividualRanking|export const assertNoIndividualRanking/,
    );
    // ...and actually invoked where the page says every report is checked. A guard that exists but is not
    // called is exactly the failure mode a reader cannot see from the page.
    expect(callSite, 'generate.ts no longer calls the guard the stance credits').toContain(
      'assertNoIndividualRanking',
    );
  });

  it('claims no per-person score, leaderboard or productivity index', () => {
    for (const banned of ['per-person score', 'leaderboard', 'productivity index', 'percentile']) {
      expect(`${NO_RANKING_STANCE.lede}\n${text}`.toLowerCase()).toContain(banned);
    }
  });

  it('states what it does not promise, rather than overclaiming', () => {
    // A page that claimed software could stop a manager forming a view would be the dishonest version, and
    // the honest limitation is itself part of the published stance.
    expect(text).toMatch(/cannot stop a manager reading a report and forming a view/);
  });
});

describe('the DPIA is completed rather than templated', () => {
  const text = textOf(DPIA);

  it('follows the Article 35(7) structure', () => {
    const headings = DPIA.sections.map((section) => section.heading);
    expect(headings.length).toBeGreaterThanOrEqual(4);
    // The processing, the necessity, the risks, the measures — in that order, numbered.
    expect(headings[0]).toMatch(/^1\./);
    expect(text.toLowerCase()).toContain('necessity and proportionality');
    expect(text.toLowerCase()).toContain('risk');
  });

  it('names the controller, the processor and a lawful basis', () => {
    expect(text).toMatch(/legitimate interest/);
    expect(text).toMatch(/Compass is the processor/);
  });

  it('contains no unfilled template placeholders', () => {
    /**
     * `docs/legal/*.md` are the pre-review drafts and are full of `[BRACKETED]` placeholders. They are
     * deliberately not what the product serves — publishing a policy with `[DATE]` in it is worse than
     * publishing nothing, because it tells a reader nobody has read it either.
     */
    for (const document of POLICY_DOCUMENTS) {
      const body = `${document.title}\n${document.lede}\n${textOf(document)}`;
      expect(body, `${document.slug} contains an unfilled placeholder`).not.toMatch(/\[[A-Z][A-Z_ ]{2,}\]/);
      expect(body, `${document.slug} contains TODO/TBD text`).not.toMatch(/\bTODO\b|\bTBD\b|\bFIXME\b/);
    }
  });
});

describe('every published document is well-formed', () => {
  it('has a unique slug, a lede, a hand-maintained ISO date and non-empty sections', () => {
    expect(POLICY_DOCUMENTS).toContain(TERMS);
    expect(POLICY_DOCUMENTS).toContain(PRIVACY_POLICY);

    const slugs = POLICY_DOCUMENTS.map((document) => document.slug);
    // The `/legal/[slug]` route resolves against these, so a duplicate would make one document
    // unreachable depending on array order.
    expect(new Set(slugs).size).toBe(slugs.length);

    for (const document of POLICY_DOCUMENTS) {
      expect(document.slug, 'a slug must be URL-safe — it is a route segment').toMatch(/^[a-z0-9-]+$/);
      expect(document.lede.length).toBeGreaterThan(20);
      expect(document.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(document.lastUpdated))).toBe(false);
      expect(document.sections.length).toBeGreaterThan(0);

      for (const section of document.sections) {
        expect(section.heading.length, `${document.slug} has an empty heading`).toBeGreaterThan(0);
        expect(section.paragraphs.length, `${document.slug}/${section.heading} has no prose`).toBeGreaterThan(0);
      }
    }
  });

  it('gives a contact address for what is not published', () => {
    expect(TRUST_CONTACT).toMatch(/^[^@\s]+@[^@\s]+$/);
  });
});

describe('the subprocessor list is disclosed at the granularity promised', () => {
  it('names a data category and region for every entry, with unique ids', () => {
    const ids = SUBPROCESSORS.map((entry) => entry.id);
    // The digest and the change diff are both keyed on id, so a duplicate would silently collapse two
    // subprocessors into one and a change to either would go unannounced.
    expect(new Set(ids).size).toBe(ids.length);

    for (const entry of SUBPROCESSORS) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.region.length, `${entry.id} does not state a processing region`).toBeGreaterThan(0);
      // "usage data" is not a category. The list promises specificity, so a one-word answer fails.
      expect(entry.dataCategory.length, `${entry.id}'s data category is too vague to be a disclosure`)
        .toBeGreaterThan(40);
      expect(entry.purpose.length).toBeGreaterThan(20);
    }
  });

  it('marks exactly the host as required, since every other one can be switched off', () => {
    const required = SUBPROCESSORS.filter((entry) => !entry.optional);
    // The zero-config posture is a real configuration rather than a promise: a deployment with no
    // Anthropic key sends nothing to a language model. Saying so is part of the disclosure.
    expect(required.map((entry) => entry.id)).toEqual(['cloud-host']);
  });

  it('commits to 30 days of advance notice', () => {
    expect(SUBPROCESSOR_NOTICE_DAYS).toBe(30);
  });
});

describe('a change to the list is detected from its content', () => {
  const digest = subprocessorDigest();

  it('is insensitive to reordering but sensitive to a field a customer cares about', () => {
    // Reordering the array is a presentation change and must not mail 400 data protection officers.
    const reversed = subprocessorDigest([...SUBPROCESSORS].reverse());
    expect(reversed).toBe(digest);

    const moved = subprocessorDigest(
      SUBPROCESSORS.map((entry) => (entry.id === 'cloud-host' ? { ...entry, region: 'Frankfurt' } : entry)),
    );
    expect(moved).not.toBe(digest);
  });

  it('describes an addition, a removal and a region change by name', () => {
    const without = subprocessorDigest(SUBPROCESSORS.filter((entry) => entry.id !== 'error-tracker'));

    const added = describeSubprocessorChanges(without, digest);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^Added: Sentry —/);

    const removed = describeSubprocessorChanges(digest, without);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^Removed: Sentry —/);

    const moved = describeSubprocessorChanges(
      digest,
      subprocessorDigest(
        SUBPROCESSORS.map((entry) => (entry.id === 'cloud-host' ? { ...entry, region: 'Frankfurt, Germany' } : entry)),
      ),
    );
    expect(moved).toHaveLength(1);
    // The old region is stated too: "we moved your data" is only actionable if a reader can see from where.
    expect(moved[0]).toMatch(/^Changed: Fly\.io —/);
    expect(moved[0]).toContain('previously processed in');
  });

  it('reads a rename as a change to one entry rather than a removal plus an addition', () => {
    const renamed = subprocessorDigest(
      SUBPROCESSORS.map((entry) => (entry.id === 'email-sender' ? { ...entry, name: 'Postmark' } : entry)),
    );
    const changes = describeSubprocessorChanges(digest, renamed);

    // Keyed on id, so a provider that rebrands does not read as Compass having swapped subprocessors.
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^Changed: Postmark —/);
    expect(changes[0]).toContain('previously named Resend');
  });

  it('says nothing when nothing changed, and nothing when there is no baseline', () => {
    expect(describeSubprocessorChanges(digest, digest)).toEqual([]);
    // A row written before the first notice is not "everything is new" — mailing a full list to somebody
    // who just subscribed, labelled as a change, would be a false statement about our own history.
    expect(describeSubprocessorChanges(null, digest)).toEqual([]);
  });

  it('produces the same description twice, so the notice email is deterministic', () => {
    const without = subprocessorDigest(SUBPROCESSORS.slice(1));
    expect(describeSubprocessorChanges(without, digest)).toEqual(describeSubprocessorChanges(without, digest));
  });
});
