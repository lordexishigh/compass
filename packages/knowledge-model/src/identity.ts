import type { Instant } from '@compass/clock';

import type { KnowledgeStore } from './store.js';
import { unionSorted, type FieldValue } from './values.js';

/**
 * Identity resolution.
 *
 * Every artifact arrives attributed to a source's own idea of a person: a git
 * author email, a tracker account id, a chat user id. One human has several of
 * them, and some of them belong to no human at all — a CI robot, a bastion host
 * with an unconfigured git identity, a contractor with no seat in the tracker.
 *
 * There is exactly one rule and it is worth stating baldly: **an artifact is
 * attributed to a Developer if and only if a declared IdentityLink matches the
 * source's identifier exactly.** Not a display name, not a similar display name,
 * not a local-part that looks like a first name. `p.raman@personal.example` with
 * the display name "P. Raman" is not Priya Raman, and the seeded dataset carries
 * that address specifically so the rule can be tested rather than asserted.
 *
 * When nothing matches, the artifact is not dropped and not guessed at: an
 * `UnmatchedIdentity` row is created or grown, the artifact records which one, and
 * the report can say "3 commits could not be tied to a person" as a question in
 * the product's own voice.
 */

export type IdentityKind = 'email' | 'account' | 'handle';

export interface ExternalActor {
  readonly kind: IdentityKind;
  readonly value: string;
  /** Carried for display only. The resolver never reads it. */
  readonly displayName: string | null;
}

/**
 * Normalises an identifier for comparison.
 *
 * Email addresses are case-folded because mail is case-insensitive in practice and
 * git records whatever the author typed. Tracker accounts and chat handles are
 * only trimmed: those are opaque provider ids, and folding case on an opaque id
 * risks collapsing two distinct accounts into one.
 */
export function normalizeIdentityValue(kind: IdentityKind, value: string): string {
  const trimmed = value.trim();
  return kind === 'email' ? trimmed.toLowerCase() : trimmed;
}

/** The natural key of an IdentityLink and of an UnmatchedIdentity alike. */
export function identityNaturalKey(kind: IdentityKind, value: string): string {
  return `${kind}:${normalizeIdentityValue(kind, value)}`;
}

export type IdentityResolution =
  | {
      readonly matched: true;
      readonly developerKey: string;
      readonly identityLinkKey: string;
      readonly unmatchedIdentityKey: null;
    }
  | {
      readonly matched: false;
      readonly developerKey: null;
      readonly identityLinkKey: null;
      readonly unmatchedIdentityKey: string;
    };

export interface UnmatchedWitness {
  /** The artifact family the unresolvable actor appeared in. */
  readonly artifactKind: string;
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  /** The artifact's own event time, so sighting bounds stay honest. */
  readonly observedAt: Instant;
}

/**
 * Resolves actors against the declared roster.
 *
 * The link table is loaded once per instance and held in memory: a full ingest
 * resolves tens of thousands of actors and the roster is a few dozen rows. Call
 * `load()` again after the roster changes.
 */
export class IdentityResolver {
  readonly #store: KnowledgeStore;
  #linksByKey = new Map<string, { readonly developerKey: string; readonly identityLinkKey: string }>();
  #loaded = false;

  constructor(store: KnowledgeStore) {
    this.#store = store;
  }

  async load(): Promise<void> {
    const links = await this.#store.list('identity_link');
    this.#linksByKey = new Map(
      links.map((link) => [
        identityNaturalKey(String(link.fields['identityKind']) as IdentityKind, String(link.fields['identityValue'])),
        { developerKey: String(link.fields['developerKey']), identityLinkKey: link.naturalKey },
      ]),
    );
    this.#loaded = true;
  }

  get linkCount(): number {
    return this.#linksByKey.size;
  }

  /**
   * The pure half: does a declared link cover this identifier?
   *
   * Separated from the write path so a test can prove the decision depends on the
   * identifier and nothing else — pass the same value with twelve different
   * display names and the answer must not move.
   */
  lookup(actor: ExternalActor): { readonly developerKey: string; readonly identityLinkKey: string } | null {
    if (!this.#loaded) {
      throw new Error('IdentityResolver.load() must run before an actor can be resolved.');
    }
    return this.#linksByKey.get(identityNaturalKey(actor.kind, actor.value)) ?? null;
  }

  /**
   * Resolves an actor, recording an `UnmatchedIdentity` when nothing matches.
   *
   * The unmatched row's occurrence count is the size of a sorted set of witnesses,
   * grown by union — so re-ingesting the same window leaves it untouched, and a
   * genuinely new commit from the same address raises it by one.
   */
  async resolve(actor: ExternalActor, witness: UnmatchedWitness): Promise<IdentityResolution> {
    const link = this.lookup(actor);
    if (link !== null) {
      return {
        matched: true,
        developerKey: link.developerKey,
        identityLinkKey: link.identityLinkKey,
        unmatchedIdentityKey: null,
      };
    }

    const naturalKey = identityNaturalKey(actor.kind, actor.value);
    const prior = await this.#store.read('unmatched_identity', naturalKey);
    const witnessRef = `${witness.sourceKey}:${witness.sourceRecordId}`;

    const witnessRefs = unionSorted((prior?.fields['witnessRefs'] as readonly unknown[] | undefined) ?? null, [
      witnessRef,
    ]);
    const artifactKinds = unionSorted((prior?.fields['artifactKinds'] as readonly unknown[] | undefined) ?? null, [
      witness.artifactKind,
    ]);
    const sourceKeys = unionSorted((prior?.fields['sourceKeys'] as readonly unknown[] | undefined) ?? null, [
      witness.sourceKey,
    ]);

    const fields: Record<string, FieldValue> = {
      identityKind: actor.kind,
      identityValue: normalizeIdentityValue(actor.kind, actor.value),
      // Kept for the manager to read, so they can recognise the address. It plays
      // no part in matching, here or anywhere.
      displayName: actor.displayName,
      occurrenceCount: witnessRefs.length,
      witnessRefs,
      artifactKinds,
      sourceKeys,
    };

    await this.#store.observe({
      kind: 'unmatched_identity',
      naturalKey,
      fields,
      observedAt: witness.observedAt,
      evidence: {
        kind: witness.artifactKind,
        label: normalizeIdentityValue(actor.kind, actor.value),
        sourceKey: witness.sourceKey,
        sourceRecordId: witness.sourceRecordId,
      },
    });

    return {
      matched: false,
      developerKey: null,
      identityLinkKey: null,
      unmatchedIdentityKey: naturalKey,
    };
  }

  /**
   * Resolves without recording anything — for actors mentioned in passing, such as
   * a requested reviewer on a pull request, where the artifact is not theirs.
   */
  resolveWithoutWitness(actor: ExternalActor): string | null {
    return this.lookup(actor)?.developerKey ?? null;
  }
}
