/**
 * The seeded snapshot builder, re-exported from the package that now owns it.
 *
 * The body of this file moved to `@compass/seed-snapshot` when three consumers
 * appeared where there had been one: the analysis suites here, the golden fixture
 * suite in `tools/golden`, and the determinism gate that regenerates a day in a
 * separate process. A helper reachable only by a relative path into this
 * directory could not serve the other two without the sort of cross-package
 * relative import `.dependency-cruiser.cjs` exists to forbid.
 *
 * This file stays as a re-export rather than being deleted so that every suite in
 * `packages/analysis/tests` keeps the import it already had — the move is a fact
 * about where the code lives, not a change to what any test says.
 */
export {
  SEED_NOW,
  SEED_ORGANIZATION_ID,
  SEED_TIMEZONE,
  SEED_WINDOW,
  buildSeedSnapshot,
  mergedButUnreachableSnapshot,
  orphanPullRequestSnapshot,
  resequencedTicketSnapshot,
  seedIsAvailable,
  seedSnapshotWithoutEstimationNoise,
  wellRunTeamSnapshot,
  type SeedSnapshotOptions,
  type WellRunTeamOptions,
} from '@compass/seed-snapshot';
