import type { Instant } from '@compass/clock';

import { identityNaturalKey, normalizeIdentityValue, type IdentityKind } from './identity.js';
import {
  UNLINKED_DEVELOPER_KEY,
  addIdentityLink,
  attributionImpact,
  upsertDeveloper,
  type AttributionImpact,
} from './roster-service.js';
import type { KnowledgeStore } from './store.js';

/**
 * Merging an unmatched identity into a person, and undoing it exactly.
 *
 * A wrong merge is the most expensive mistake this surface can make: it moves somebody
 * else's commits onto a person, and every report generated afterwards states that as fact.
 * So un-merge is not a nice-to-have — it is the only recovery, and it has to restore the
 * prior attribution *exactly* rather than approximately.
 *
 * ## Why the snapshot is taken at merge time
 *
 * "Exactly" cannot be reconstructed afterwards. Once a link exists, the model no longer
 * records which artifacts were unattributed before it did — the identifier now resolves,
 * and asking "who was this attributed to yesterday" needs yesterday's answer, not a
 * re-derivation from today's links. So the merge writes the pre-merge state into its own
 * record: which developer (if any) held the identifier, and the exact set of artifact keys
 * that were attributed through it. The un-merge replays that.
 *
 * ## Why no artifact is rewritten
 *
 * Attribution is resolved through `identity_link` when a report is generated, from the
 * `authorIdentityKey` that ingest records on every artifact. So a merge writes exactly one
 * row — the link — and an un-merge writes exactly one row that undoes it. Neither touches
 * a commit or a pull request, which is how "restore the prior attribution exactly" and
 * "never delete the underlying artifacts" are the same statement rather than two
 * competing ones. It is also why both take effect in the next generated report with no
 * re-ingest at all.
 */

export type MergeTarget =
  | { readonly kind: 'existing'; readonly developerKey: string }
  | {
      readonly kind: 'new';
      readonly developerKey: string;
      readonly displayName: string;
      readonly teamKey: string | null;
    };

/**
 * Everything an un-merge needs, captured before the merge happens.
 *
 * Serialised into the AuditLogEntry's `before` state, which is append-only — so the record
 * an un-merge replays cannot itself have been edited between the two acts.
 */
export interface PreMergeAttribution {
  readonly identityKey: string;
  readonly identityKind: IdentityKind;
  readonly identityValue: string;
  /** The developer the identifier resolved to before the merge, or null if unattributed. */
  readonly priorDeveloperKey: string | null;
  /** The `origin` of the link that existed before, so restoring it is byte-exact. */
  readonly priorOrigin: string | null;
  /** Whether a link row existed at all. Distinct from `priorDeveloperKey === null`. */
  readonly priorLinkExisted: boolean;
  /** The artifacts attributed through this identifier at merge time, sorted. */
  readonly artifactKeys: readonly string[];
  readonly commitCount: number;
  readonly pullRequestCount: number;
}

export interface MergeResult {
  readonly identityKey: string;
  readonly developerKey: string;
  /** Replay this to undo the merge. Store it; it cannot be recomputed later. */
  readonly preMerge: PreMergeAttribution;
  readonly impact: AttributionImpact;
  /** True when the merge created the Developer as well as the link. */
  readonly developerCreated: boolean;
}

export class UnmatchedIdentityNotFoundError extends Error {
  readonly detail: string;

  constructor(identityKey: string) {
    const detail =
      `No unmatched identity \`${identityKey}\` is in the queue. It may already have been merged, ` +
      'or the queue may have been read before the last ingest.';
    super(detail);
    this.name = 'UnmatchedIdentityNotFoundError';
    this.detail = detail;
  }
}

/** The full artifact key set attributed through one identifier, for the snapshot. */
async function attributedArtifactKeys(
  store: KnowledgeStore,
  identityKey: string,
): Promise<{ readonly keys: readonly string[]; readonly commits: number; readonly pullRequests: number }> {
  const [commits, pullRequests] = await Promise.all([store.list('commit'), store.list('pull_request')]);

  const matching = (entities: readonly { readonly naturalKey: string; readonly fields: Readonly<Record<string, unknown>> }[]) =>
    entities
      .filter(
        (entity) =>
          entity.fields['authorIdentityKey'] === identityKey ||
          entity.fields['unmatchedIdentityKey'] === identityKey,
      )
      .map((entity) => entity.naturalKey);

  const commitKeys = matching(commits);
  const pullRequestKeys = matching(pullRequests);

  return {
    // Sorted so the snapshot is byte-stable and two merges of the same state compare equal.
    keys: [...commitKeys, ...pullRequestKeys].sort(),
    commits: commitKeys.length,
    pullRequests: pullRequestKeys.length,
  };
}

/**
 * Merges an unmatched identity into a developer, existing or new.
 *
 * The unmatched row is left in place. It is the evidence that the identifier was once
 * unplaceable and the thing the un-merge restores the queue to; deleting it would make the
 * undo path have to invent a row, and an invented row is not a restoration.
 */
export async function mergeUnmatchedIdentity(
  store: KnowledgeStore,
  input: { readonly identityKey: string; readonly target: MergeTarget },
  at: Instant,
): Promise<MergeResult> {
  const unmatched = await store.read('unmatched_identity', input.identityKey);
  if (unmatched === null) throw new UnmatchedIdentityNotFoundError(input.identityKey);

  const identityKind = String(unmatched.fields['identityKind']) as IdentityKind;
  const identityValue = String(unmatched.fields['identityValue']);

  const existingLink = await store.read('identity_link', input.identityKey);
  const priorDeveloperKey =
    existingLink === null ? null : String(existingLink.fields['developerKey'] ?? '') || null;

  // Captured *before* the link is written. After it, this is unrecoverable.
  const attributed = await attributedArtifactKeys(store, input.identityKey);
  const preMerge: PreMergeAttribution = {
    identityKey: input.identityKey,
    identityKind,
    identityValue,
    priorDeveloperKey,
    priorOrigin: existingLink === null ? null : String(existingLink.fields['origin'] ?? 'declared'),
    priorLinkExisted: existingLink !== null,
    artifactKeys: attributed.keys,
    commitCount: attributed.commits,
    pullRequestCount: attributed.pullRequests,
  };

  let developerCreated = false;
  if (input.target.kind === 'new') {
    const created = await upsertDeveloper(
      store,
      {
        key: input.target.developerKey,
        displayName: input.target.displayName,
        teamKey: input.target.teamKey,
        active: true,
      },
      at,
    );
    developerCreated = created.outcome === 'created';
  }

  const link = await addIdentityLink(
    store,
    {
      kind: identityKind,
      value: identityValue,
      developerKey: input.target.developerKey,
      origin: 'merged',
    },
    at,
  );

  return {
    identityKey: input.identityKey,
    developerKey: input.target.developerKey,
    preMerge,
    impact: link.impact,
    developerCreated,
  };
}

export interface UnmergeResult {
  readonly identityKey: string;
  /** What the identifier resolves to now — null when it is unattributed again. */
  readonly restoredDeveloperKey: string | null;
  /** The artifacts the un-merge handed back, from the merge's own snapshot. */
  readonly restoredArtifactKeys: readonly string[];
  /** True when every artifact the merge moved is accounted for in the restoration. */
  readonly exact: boolean;
  readonly impact: AttributionImpact;
}

/**
 * Undoes a merge, restoring the attribution the snapshot recorded.
 *
 * `exact` reports whether the restoration is complete rather than assuming it. It can be
 * false for one honest reason: an ingest between the merge and the un-merge observed *new*
 * artifacts under the same identifier, which the merge's snapshot could not have known
 * about. Those revert too — the link is what attributes them and the link is gone — but
 * they were not in the set the merge moved, so the un-merge says so instead of quietly
 * claiming a perfect undo.
 */
export async function unmergeIdentity(
  store: KnowledgeStore,
  preMerge: PreMergeAttribution,
  at: Instant,
): Promise<UnmergeResult> {
  // The identifier goes back to exactly what it was: the prior developer if a link
  // existed, or nobody. `UNLINKED_DEVELOPER_KEY` rather than a delete, so *when* it was
  // undone is on disk.
  const restoredDeveloperKey = preMerge.priorLinkExisted ? preMerge.priorDeveloperKey : null;

  await store.observe({
    kind: 'identity_link',
    naturalKey: preMerge.identityKey,
    fields: {
      identityKind: preMerge.identityKind,
      identityValue: normalizeIdentityValue(preMerge.identityKind, preMerge.identityValue),
      developerKey: restoredDeveloperKey ?? UNLINKED_DEVELOPER_KEY,
      origin: preMerge.priorOrigin ?? 'declared',
    },
    observedAt: at,
    evidence: null,
  });

  const impact = await attributionImpact(store, preMerge.identityKey);
  const current = await attributedArtifactKeys(store, preMerge.identityKey);

  return {
    identityKey: preMerge.identityKey,
    restoredDeveloperKey,
    restoredArtifactKeys: preMerge.artifactKeys,
    exact:
      current.keys.length === preMerge.artifactKeys.length &&
      current.keys.every((key, index) => key === preMerge.artifactKeys[index]),
    impact,
  };
}

/** Round-trips a snapshot through the audit log's jsonb, checking it on the way back. */
export function isPreMergeAttribution(value: unknown): value is PreMergeAttribution {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['identityKey'] === 'string' &&
    typeof candidate['identityKind'] === 'string' &&
    typeof candidate['identityValue'] === 'string' &&
    typeof candidate['priorLinkExisted'] === 'boolean' &&
    Array.isArray(candidate['artifactKeys'])
  );
}

/** The identity key of an unmatched row, for callers that hold a kind and a value. */
export const unmatchedIdentityKeyOf = (kind: IdentityKind, value: string): string =>
  identityNaturalKey(kind, value);
