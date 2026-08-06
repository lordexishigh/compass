import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_CITING_CLAIMS, findClaimsCitingArtifact, type ScopedDb, type StoredReportEvidence } from '@compass/db';
import { ARTIFACT_ROUTE_KINDS, artifactHref, isArtifactRouteKind } from '@compass/pipeline';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArtifactDetail } from '../components/artifact-detail';
import { identifiersOf, type ArtifactView } from '../lib/artifact-source';

import { storedBundle } from './helpers/report-fixture';

const evidenceFor = (stableId: string) =>
  storedBundle()
    .sections.flatMap((section) => section.items)
    .find((item) => item.stableId === stableId)?.evidence[0];

const view = (overrides: Partial<ArtifactView> = {}): ArtifactView => ({
  kind: 'pull_request',
  artifactId: 'pr-883',
  knownKind: true,
  title: 'pull request #883',
  sourceKey: 'primary-code',
  identifiers: identifiersOf(evidenceFor('yesterday:ticket:DEV-501')),
  claims: [
    {
      reportId: 'report-1',
      reportDate: '2026-07-31',
      sectionKey: 'yesterday',
      sectionTitle: 'Yesterday',
      sectionOrdinal: 1,
      headline: 'DEV-501 via #883 — Batch the checkout writer',
      detail: 'Reached R3 accepted.',
    },
  ],
  ...overrides,
});

describe('the artifact detail page', () => {
  it('shows the underlying identifiers the claim was built from', () => {
    const markup = renderToStaticMarkup(<ArtifactDetail artifact={view()} />);

    expect(markup).toContain('Tracker key');
    expect(markup).toContain('DEV-501');
    expect(markup).toContain('Source record');
    expect(markup).toContain('issue-DEV-501');
  });

  it('lists every claim that cited the artifact, with the section it sat in', () => {
    const markup = renderToStaticMarkup(<ArtifactDetail artifact={view()} />);

    expect(markup).toContain('2026-07-31');
    expect(markup).toContain('Yesterday');
    expect(markup).toContain('Batch the checkout writer');
  });

  it('states an uncited artifact rather than rendering an empty page', () => {
    const markup = renderToStaticMarkup(<ArtifactDetail artifact={view({ claims: [] })} />);

    expect(markup).toContain('No report has cited this artifact yet');
    expect(markup).toContain('stated-absence');
  });

  it('still resolves a kind it has no page for, and says which kind that was', () => {
    const markup = renderToStaticMarkup(
      <ArtifactDetail artifact={view({ kind: 'wiki_page', knownKind: false, identifiers: [], claims: [] })} />,
    );

    expect(markup).toContain('no detail page for artifacts of kind');
    expect(markup).toContain('wiki_page');
  });

  it('offers a way back to the report', () => {
    expect(renderToStaticMarkup(<ArtifactDetail artifact={view()} />)).toContain('href="/"');
  });

  it('carries no chart, canvas or svg either', () => {
    const markup = renderToStaticMarkup(<ArtifactDetail artifact={view()} />).toLowerCase();

    for (const forbidden of ['<canvas', '<svg', 'chart', 'sparkline', 'gauge']) {
      expect(markup).not.toContain(forbidden);
    }
  });
});

describe('the typed identifier columns', () => {
  it('surfaces a commit SHA as its own labelled field', () => {
    const identifiers = identifiersOf(evidenceFor('win:ticket:DEV-501'));

    expect(identifiers.map((entry) => entry.label)).toContain('Commit SHA');
    expect(identifiers.find((entry) => entry.label === 'Commit SHA')?.value).toBe('7a8b9c0d1e2f');
  });

  it('surfaces a pull request number as its own labelled field', () => {
    const pullRequest = storedBundle()
      .sections.flatMap((section) => section.items)
      .flatMap((item) => item.evidence)
      .find((reference) => reference.kind === 'pull_request');

    expect(identifiersOf(pullRequest).map((entry) => entry.value)).toContain('#883');
  });

  it('says nothing at all when there is no evidence row to read', () => {
    expect(identifiersOf(undefined)).toEqual([]);
  });
});

/**
 * The read budget behind `/artifact/<kind>/<id>`, pinned.
 *
 * Every claim in every report links here, so this route's cost is the evidence surface's cost.
 * It resolved in two reads and then fanned out: `findClaimsCitingArtifact` ran three queries per
 * citing item, awaited in sequence, and re-read the evidence range the caller had already read —
 * `3n + 2` round trips for an artifact cited `n` times. Nothing bounded `n`, and it grows with
 * every report written about the artifact, which is precisely the axis that grows now that time
 * travel is reachable from `/` and the archive fills up. A page that gets slower the more the
 * product is used is the shape of the hang the review reported.
 *
 * So the assertion is a *count*, not a timing: timings pass on an empty fixture and on a laptop
 * with a local database, which is exactly how this survived. A count fails the moment the loop
 * comes back.
 */
describe('the artifact page reads a bounded number of times', () => {
  /**
   * A `ScopedDb` that answers in call order and counts.
   *
   * The sequence `findClaimsCitingArtifact` issues is deterministic — items, then sections, then
   * reports — so returning by call index needs no table identity and no query parsing, and the
   * test fails loudly if that sequence changes rather than silently returning empty rows.
   */
  /**
   * The ids an `inArray(column, ids)` predicate actually asks the database for.
   *
   * Drizzle keeps them as `Param` entries inside an array chunk of the built SQL. Reading them is
   * what lets this pin the bound on the *query* rather than on the rows that come back — the cap
   * exists to protect the database, so asking for 250 ids and discarding 50 afterwards would be
   * the same defect wearing a passing assertion.
   */
  const boundIds = (where: unknown): string[] => {
    const chunks = (where as { queryChunks?: readonly unknown[] } | undefined)?.queryChunks ?? [];
    return chunks.flatMap((chunk) =>
      Array.isArray(chunk)
        ? chunk.flatMap((entry) => {
            const value = (entry as { value?: unknown }).value;
            return typeof value === 'string' ? [value] : [];
          })
        : [],
    );
  };

  const countingDb = (responses: readonly (readonly unknown[])[]) => {
    const asked: string[][] = [];

    const scoped = {
      organizationId: 'org-1',
      selectFrom(_table: unknown, where?: unknown) {
        const ids = boundIds(where);
        const available = responses[asked.length] ?? [];
        asked.push(ids);

        // Honours the predicate, so a query that asked for too much cannot be rescued by a stub
        // that hands back the right rows anyway. An `eq`-only predicate binds no array, and those
        // reads are already single-row by construction.
        const rows =
          ids.length === 0
            ? available
            : available.filter((row) => ids.includes((row as { id: string }).id));

        const chain = {
          orderBy: () => chain,
          limit: () => chain,
          then: (resolve: (value: readonly unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      },
    };

    return {
      scoped: scoped as unknown as ScopedDb,
      queryCount: () => asked.length,
      idsAskedFor: (call: number) => asked[call] ?? [],
    };
  };

  const evidenceRows = (count: number): readonly StoredReportEvidence[] =>
    Array.from({ length: count }, (_unused, index) => ({
      id: `evidence-${index}`,
      reportItemId: `item-${index}`,
      ordinal: 0,
      kind: 'pull_request',
      label: `#${index}`,
      sourceKey: 'primary-code',
      sourceRecordId: `pr-${index}`,
      commitSha: null,
      pullRequestNumber: index,
      issueKey: null,
      artifactKind: 'pull_request',
      artifactId: 'pr-883',
    }));

  const itemRows = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      id: `item-${index}`,
      reportId: `report-${index}`,
      reportSectionId: `section-${index}`,
      stableId: `yesterday:ticket:DEV-${index}`,
      headline: `headline ${index}`,
      detail: `detail ${index}`,
    }));

  it('costs the same three reads whether one claim cited the artifact or eighty', async () => {
    const budgets: number[] = [];

    for (const size of [1, 80]) {
      const database = countingDb([
        itemRows(size),
        [{ id: 'section-0', sectionKey: 'yesterday', title: 'Yesterday', ordinal: 1 }],
        [{ id: 'report-0', reportDate: '2026-07-31' }],
      ]);

      // Awaited, because the reads are sequential awaits — counting before they resolve would
      // pin the number 1 and pass against the very loop this exists to forbid.
      await findClaimsCitingArtifact(database.scoped, 'pull_request', 'pr-883', evidenceRows(size));
      budgets.push(database.queryCount());
    }

    // Not merely "equal": three is the whole plan — items, sections, reports.
    expect(budgets[0], 'one citing claim must not cost more than the set-based plan').toBe(3);
    expect(budgets[1], 'eighty citing claims must cost exactly what one does').toBe(3);
  });

  it('reads the evidence range once, not once per caller', async () => {
    // The loader already holds the evidence rows — it needs the first one for the identifier
    // list — so handing them over is what stops the same indexed range being scanned twice.
    const withEvidence = countingDb([itemRows(4), [], []]);
    await findClaimsCitingArtifact(withEvidence.scoped, 'pull_request', 'pr-883', evidenceRows(4));

    const withoutEvidence = countingDb([evidenceRows(4), itemRows(4), [], []]);
    await findClaimsCitingArtifact(withoutEvidence.scoped, 'pull_request', 'pr-883');

    expect(withoutEvidence.queryCount() - withEvidence.queryCount()).toBe(1);
  });

  it('caps how many citing claims one artifact asks the database for', async () => {
    const size = MAX_CITING_CLAIMS + 50;
    expect(MAX_CITING_CLAIMS, 'the fixture has to exceed the cap for this to assert anything').toBeLessThan(size);

    const database = countingDb([itemRows(size), [], []]);
    const claims = await findClaimsCitingArtifact(database.scoped, 'pull_request', 'pr-883', evidenceRows(size));

    // The query itself, not the rows it returned: an unbounded `inArray` would put all 250 ids on
    // the wire and the page would still look right.
    expect(database.idsAskedFor(0)).toHaveLength(MAX_CITING_CLAIMS);
    expect(claims.length).toBeLessThanOrEqual(MAX_CITING_CLAIMS);
  });

  it('generates nothing: the loader never reaches the pipeline write path', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'artifact-source.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');

    for (const forbidden of [
      'ensureDailyReport',
      'ensureTodaysReport',
      'regenerateForInstant',
      'SeedConnector',
      'narratorFromEnvironment',
      // The archive's own unbounded shape: every bundle in the org, the way `mentionsOf` reads.
      'listReportArchive',
      'loadReportBundle',
    ]) {
      expect(source, `\`${forbidden}\` would make following an evidence marker cost a generation`).not.toContain(
        forbidden,
      );
    }

    // The pool comes from `lib/database.ts`; `lib/report-source.ts` re-exports it but drags the
    // analysis core and the narrator in behind it.
    expect(source).toContain("from './database'");
    expect(source).not.toContain("from './report-source'");
  });
});

describe('the artifact route contract', () => {
  it('builds one path shape for every kind the port produces', () => {
    for (const kind of ARTIFACT_ROUTE_KINDS) {
      expect(artifactHref(kind, 'checkout-web:abc')).toBe(`/artifact/${kind}/checkout-web%3Aabc`);
      expect(isArtifactRouteKind(kind)).toBe(true);
    }
  });

  it('rejects a kind Compass does not produce, without throwing', () => {
    expect(isArtifactRouteKind('wiki_page')).toBe(false);
    expect(artifactHref('wiki_page', 'x')).toBe('/artifact/wiki_page/x');
  });
});
