import {
  ScopedDb,
  findClaimsCitingArtifact,
  findEvidenceForArtifact,
  orgScope,
  type CitingClaim,
  type StoredReportEvidence,
} from '@compass/db';
import { isArtifactRouteKind } from '@compass/pipeline';

import { database } from './database';
import { resolveProvider } from './foundation-report';
import { describeArtifact } from './view-model';

/**
 * The artifact detail page's read model.
 *
 * Every computed claim in a report carries a marker, and every marker resolves
 * here. That is what makes a claim checkable rather than merely confident: the
 * reader lands on the underlying commit SHA, pull request number or tracker key,
 * and sees every claim Compass has ever made about it.
 *
 * Two absences are stated rather than hidden. An artifact *kind* Compass has no
 * page for still resolves — the page says which kind it was asked for — because
 * dropping the link would leave a claim looking unevidenced when the evidence
 * exists. An artifact nobody has cited resolves too, and says exactly that.
 *
 * ## The pool comes from `lib/database.ts`, not from the report path
 *
 * `database` is re-exported by `lib/report-source.ts` and this module used to take it from
 * there, which pulled `ensureDailyReport`, the seeded connector and the narrator into the
 * module graph of a route that generates nothing. Same reason `/api/health` reaches for the
 * pool directly: this is a read of stored rows, and it should not load the analysis core to
 * perform one. `tests/artifact.test.tsx` asserts the import stays this way round.
 */

export interface ArtifactIdentifierView {
  readonly label: string;
  readonly value: string;
}

export interface ArtifactClaimView {
  readonly reportId: string;
  readonly reportDate: string;
  readonly sectionKey: string;
  readonly sectionTitle: string;
  readonly sectionOrdinal: number;
  readonly headline: string;
  readonly detail: string;
}

export interface ArtifactView {
  readonly kind: string;
  readonly artifactId: string;
  /** False when the route named a kind the port does not produce. */
  readonly knownKind: boolean;
  readonly title: string;
  readonly sourceKey: string | null;
  /** The typed identifiers this artifact carries: SHA, PR number, tracker key. */
  readonly identifiers: readonly ArtifactIdentifierView[];
  readonly claims: readonly ArtifactClaimView[];
}

/** The typed columns the evidence row carries, as label/value pairs. */
export function identifiersOf(evidence: StoredReportEvidence | undefined): readonly ArtifactIdentifierView[] {
  if (evidence === undefined) return [];
  const found: ArtifactIdentifierView[] = [];
  if (evidence.commitSha !== null) found.push({ label: 'Commit SHA', value: evidence.commitSha });
  if (evidence.pullRequestNumber !== null) {
    found.push({ label: 'Pull request', value: `#${evidence.pullRequestNumber}` });
  }
  if (evidence.issueKey !== null) found.push({ label: 'Tracker key', value: evidence.issueKey });
  found.push({ label: 'Source', value: evidence.sourceKey });
  found.push({ label: 'Source record', value: evidence.sourceRecordId });
  return found;
}

const claimView = (claim: CitingClaim): ArtifactClaimView => ({
  reportId: claim.reportId,
  reportDate: claim.reportDate,
  sectionKey: claim.sectionKey,
  sectionTitle: claim.sectionTitle,
  sectionOrdinal: claim.sectionOrdinal,
  headline: claim.headline,
  detail: claim.detail,
});

export async function loadArtifactView(kind: string, artifactId: string): Promise<ArtifactView> {
  const provider = resolveProvider();
  const scoped = new ScopedDb(database(), orgScope(provider.organizationId));

  /**
   * Two bounded reads, and nothing generated.
   *
   * The evidence rows are read once and handed on, rather than read again inside
   * `findClaimsCitingArtifact` — the page needs them for the identifiers across the top and
   * that resolver needs them for the claim list, and they are the same indexed range.
   *
   * The rule this path keeps is `loadArchivedReport`'s: it *reads*. Nothing here resolves a
   * connector, opens an ingest window or calls the pipeline, so following an evidence marker
   * costs a lookup rather than a report generation.
   */
  const evidence = await findEvidenceForArtifact(scoped, kind, artifactId);
  const claims = await findClaimsCitingArtifact(scoped, kind, artifactId, evidence);
  const first = evidence[0];

  return {
    kind,
    artifactId,
    knownKind: isArtifactRouteKind(kind),
    title: first === undefined ? describeArtifact(kind, artifactId) : describeArtifact(first.kind, first.label),
    sourceKey: first?.sourceKey ?? null,
    identifiers: identifiersOf(first),
    claims: claims.map(claimView),
  };
}
