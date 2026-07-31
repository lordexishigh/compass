import type { KnowledgeStore } from '@compass/knowledge-model';

/**
 * Which repositories and projects an ingest run is allowed to write.
 *
 * Archival is a manager's decision — "we do not work on this any more" — and it has to
 * mean something at the ingest boundary or it means nothing at all. A repository that is
 * still pulled every morning keeps producing Yesterday items for a codebase nobody is
 * working on, and the archive button becomes decoration.
 *
 * Two properties, both required by the acceptance criterion, and they pull in opposite
 * directions:
 *
 *  - **Archived is excluded from future windows.** Nothing new is observed for it, so no
 *    new commits, pull requests, releases or branch refs arrive.
 *  - **Prior data and prior reports are intact.** Nothing is deleted, nothing is marked,
 *    no version is appended. A report generated for a past instant still resolves the
 *    repository as tracked, because the tracking decision is itself effective-dated and
 *    the past belief is still on disk.
 *
 * Absence of a `tracked_repository` row means *tracked*. That default matters: a
 * connector reports repositories Compass has never been told about, and defaulting them
 * to untracked would make a fresh deployment ingest nothing at all and look broken.
 * Archiving is an explicit act that leaves an explicit row.
 */

export interface TrackingDecisions {
  /** Repository natural keys explicitly archived. Everything else is tracked. */
  readonly archivedRepositoryKeys: ReadonlySet<string>;
  readonly archivedProjectKeys: ReadonlySet<string>;
}

export const NOTHING_ARCHIVED: TrackingDecisions = Object.freeze({
  archivedRepositoryKeys: new Set<string>(),
  archivedProjectKeys: new Set<string>(),
});

/**
 * Reads the current tracking decisions.
 *
 * The *current* belief, deliberately, not the belief at the window's start: archiving is
 * an instruction about what to do from now on, and re-ingesting an old window should not
 * resurrect a repository somebody archived this morning. Past *reports* resolve their own
 * instant from version history; past *ingests* do not get replayed against stale config.
 */
export async function loadTrackingDecisions(store: KnowledgeStore): Promise<TrackingDecisions> {
  const [repositories, projects] = await Promise.all([
    store.list('tracked_repository'),
    store.list('tracked_project'),
  ]);

  const archivedRepositoryKeys = new Set<string>();
  for (const row of repositories) {
    if (row.fields['tracked'] === false) {
      archivedRepositoryKeys.add(String(row.fields['repositoryKey'] ?? row.naturalKey));
    }
  }

  const archivedProjectKeys = new Set<string>();
  for (const row of projects) {
    if (row.fields['tracked'] === false) {
      archivedProjectKeys.add(String(row.fields['projectKey'] ?? row.naturalKey));
    }
  }

  return { archivedRepositoryKeys, archivedProjectKeys };
}

/** How much an ingest run declined to observe, so the run can say so rather than imply it. */
export interface SkippedByArchival {
  readonly repositoryKeys: readonly string[];
  readonly projectKeys: readonly string[];
  readonly recordCount: number;
}

/**
 * Accumulates what archival excluded.
 *
 * Counted rather than silently dropped: `IngestRunSummary` reports it, and a run that
 * quietly ingested nothing because every repository had been archived would otherwise be
 * indistinguishable from a run against a broken connector.
 */
export class ArchivalFilter {
  readonly #decisions: TrackingDecisions;
  readonly #repositories = new Set<string>();
  readonly #projects = new Set<string>();
  #records = 0;

  constructor(decisions: TrackingDecisions) {
    this.#decisions = decisions;
  }

  /** True when this repository is archived, and records that a record was skipped. */
  skipsRepository(repositoryKey: string | null | undefined): boolean {
    if (repositoryKey === null || repositoryKey === undefined) return false;
    if (!this.#decisions.archivedRepositoryKeys.has(repositoryKey)) return false;
    this.#repositories.add(repositoryKey);
    this.#records += 1;
    return true;
  }

  skipsProject(projectKey: string | null | undefined): boolean {
    if (projectKey === null || projectKey === undefined) return false;
    if (!this.#decisions.archivedProjectKeys.has(projectKey)) return false;
    this.#projects.add(projectKey);
    this.#records += 1;
    return true;
  }

  get skipped(): SkippedByArchival {
    return {
      repositoryKeys: [...this.#repositories].sort(),
      projectKeys: [...this.#projects].sort(),
      recordCount: this.#records,
    };
  }
}
