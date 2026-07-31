import type { KnowledgeStore, StoredEntity } from '@compass/knowledge-model';

import type { MemoSubjectKind } from './assertion.js';

/**
 * Binding a memo's subject to a real entity — or refusing to guess which one.
 *
 * ## The failure this prevents
 *
 * "Marcus is out until Thursday" in an org with a Marcus Hale and a Marcus Webb is not a
 * resolvable sentence, and the damage from picking one is asymmetric and invisible. The wrong
 * Marcus gets his stalled-work findings suppressed for a week — so the report goes quiet about
 * work that really has stopped — while the right Marcus keeps being named for work he could
 * not possibly have moved. Neither shows up as an error. Both look like Compass being
 * confidently wrong, which is precisely the thing Manager Memos exist to fix.
 *
 * So below the threshold this returns *candidates* and persists nothing. That is a worse
 * interaction and a better product: one extra click, versus a week of quietly wrong reports.
 *
 * ## Why the threshold lives here
 *
 * `SUBJECT_CONFIDENCE_THRESHOLD` is a memo-extraction tunable, not one of the analysis
 * thresholds in `packages/analysis/src/thresholds.ts`. Those are the T1–T24 numbers a report
 * *cites* — "that crosses T1 at three working days" — and every one of them appears in prose a
 * manager reads. This number never appears in a report; it decides whether a question is asked
 * before a memo exists at all. Putting it in the cited table would imply the report explains
 * itself in terms of it, and reserving that table for numbers findings quote is what keeps
 * `thresholdRef` meaningful.
 */

/**
 * How sure resolution must be to bind a subject without asking.
 *
 * 0.8 sits deliberately above a unique-surname match (0.9 passes) and below anything
 * ambiguous (0.4 fails). The gap is wide on purpose: a threshold tuned to sit between two
 * *close* scores would flip behaviour on a rename.
 */
export const SUBJECT_CONFIDENCE_THRESHOLD = 0.8;

/** Confidence for each way a hint can match, highest first. */
const CONFIDENCE = {
  /** The hint *is* the entity key, or the whole display name. */
  exact: 1,
  /** A unique surname. "Hale is out" with one Hale in the org. */
  uniqueSurname: 0.9,
  /**
   * A unique first name. Resolving this is not "first-name similarity alone" — it is the
   * only person it could be. The criterion forbids guessing *between* people who share one,
   * which is what `ambiguous` below is for.
   */
  uniqueGivenName: 0.85,
  /** More than one person matched. Never bound without a human choosing. */
  ambiguous: 0.4,
} as const;

export interface SubjectCandidate {
  readonly subjectKind: MemoSubjectKind;
  readonly subjectKey: string;
  /** What the screen shows: "Marcus Hale", "DEV-402". */
  readonly label: string;
  /** Why this one is a candidate, in the product's voice. */
  readonly reason: string;
}

export type SubjectResolution =
  | {
      readonly status: 'resolved';
      readonly subjectKind: MemoSubjectKind;
      readonly subjectKey: string;
      readonly label: string;
      readonly confidence: number;
    }
  | {
      /** 2–3 named candidates. The caller persists nothing until one is chosen. */
      readonly status: 'ambiguous';
      readonly candidates: readonly SubjectCandidate[];
      readonly confidence: number;
      readonly detail: string;
    }
  | {
      readonly status: 'not_found';
      readonly detail: string;
    };

/** The most candidates a person can usefully choose between in one sentence. */
const MAX_CANDIDATES = 3;

const displayNameOf = (entity: StoredEntity): string => {
  const value = entity.fields['displayName'];
  return typeof value === 'string' && value.length > 0 ? value : entity.naturalKey;
};

const fold = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** Strips the politeness and possessives a hint arrives wrapped in: "Priya's" -> "priya". */
const foldHint = (hint: string): string =>
  fold(hint)
    .replace(/['’]s$/, '')
    .replace(/^(?:developer|dev|engineer)\s+/, '');

const nameTokens = (name: string): readonly string[] => fold(name).split(' ').filter((part) => part.length > 0);

/**
 * Resolves a `developer` subject against the roster.
 *
 * Reads the roster's own `developer` rows rather than matching against git emails or commit
 * author strings: a memo names a *person as the manager refers to them*, and the roster is the
 * only place that mapping is declared rather than inferred. Guessing from an identity string
 * would be the same first-name-similarity mistake one layer down.
 */
export async function resolveDeveloperSubject(
  store: KnowledgeStore,
  hint: string,
): Promise<SubjectResolution> {
  const developers = await store.list('developer');
  const folded = foldHint(hint);

  if (folded.length === 0) {
    return { status: 'not_found', detail: 'The memo did not name anybody.' };
  }

  const active = developers.filter((developer) => developer.fields['active'] !== false);
  // An inactive person can still be the subject of a memo — "Marcus is out" the week he
  // leaves — so they are searched too, just after everybody who is currently on the team.
  const searchOrder = [...active, ...developers.filter((developer) => developer.fields['active'] === false)];

  const candidateFor = (developer: StoredEntity, reason: string): SubjectCandidate => ({
    subjectKind: 'developer',
    subjectKey: developer.naturalKey,
    label: displayNameOf(developer),
    reason,
  });

  // ---- exact: the key itself, or the whole name ------------------------------
  const exact = searchOrder.filter(
    (developer) => fold(developer.naturalKey) === folded || fold(displayNameOf(developer)) === folded,
  );
  if (exact.length === 1) {
    const only = exact[0] as StoredEntity;
    return {
      status: 'resolved',
      subjectKind: 'developer',
      subjectKey: only.naturalKey,
      label: displayNameOf(only),
      confidence: CONFIDENCE.exact,
    };
  }
  if (exact.length > 1) {
    return ambiguousResolution(
      exact.slice(0, MAX_CANDIDATES).map((developer) => candidateFor(developer, 'the same full name')),
      hint,
    );
  }

  // ---- surname, then given name --------------------------------------------
  //
  // Split rather than substring-matched: a substring search makes "Ana" match "Anastasia" and
  // "Dana", which is the sloppiest possible way to decide whose work stops being reported.
  const bySurname = searchOrder.filter((developer) => {
    const tokens = nameTokens(displayNameOf(developer));
    return tokens.length > 1 && tokens[tokens.length - 1] === folded;
  });
  if (bySurname.length === 1) {
    const only = bySurname[0] as StoredEntity;
    return {
      status: 'resolved',
      subjectKind: 'developer',
      subjectKey: only.naturalKey,
      label: displayNameOf(only),
      confidence: CONFIDENCE.uniqueSurname,
    };
  }

  const byGivenName = searchOrder.filter((developer) => nameTokens(displayNameOf(developer))[0] === folded);

  // Two people share the first name the memo used. **This is the case the criterion names**,
  // and the answer is to ask rather than to rank them by anything — recency, team, alphabet.
  // Every tie-breaker available here is a coin toss dressed as a reason.
  if (byGivenName.length > 1 || bySurname.length > 1) {
    const tied = byGivenName.length > 1 ? byGivenName : bySurname;
    return ambiguousResolution(
      tied
        .slice(0, MAX_CANDIDATES)
        .map((developer) => candidateFor(developer, `shares the name “${hint.trim()}”`)),
      hint,
    );
  }

  if (byGivenName.length === 1) {
    const only = byGivenName[0] as StoredEntity;
    return {
      status: 'resolved',
      subjectKind: 'developer',
      subjectKey: only.naturalKey,
      label: displayNameOf(only),
      confidence: CONFIDENCE.uniqueGivenName,
    };
  }

  return {
    status: 'not_found',
    detail:
      `Nobody on the roster is called “${hint.trim()}”. If they are new, add them on the roster screen first — ` +
      'Compass will not invent a person from a memo.',
  };
}

function ambiguousResolution(candidates: readonly SubjectCandidate[], hint: string): SubjectResolution {
  return {
    status: 'ambiguous',
    candidates,
    confidence: CONFIDENCE.ambiguous,
    detail:
      `More than one person could be “${hint.trim()}”. Compass will not pick one — the wrong choice would ` +
      'suppress the right person’s findings and keep reporting the other’s.',
  };
}

/**
 * Resolves a subject that is named by its own key: a ticket, sprint, project or team.
 *
 * These need no fuzzy matching at all — the extractor lifted `DEV-402` out of the text as a
 * literal key — so this is an existence check, and its whole value is refusing a memo about a
 * ticket the model has never seen. A memo bound to a non-existent key would sit in the list
 * looking active while affecting nothing.
 */
export async function resolveKeyedSubject(
  store: KnowledgeStore,
  subjectKind: Exclude<MemoSubjectKind, 'developer'>,
  hint: string,
): Promise<SubjectResolution> {
  const folded = foldHint(hint);

  // A `context_note` about the team as a whole is the one subject with no row to find: it is
  // the standing scope of the report rather than an entity somebody configured.
  if (subjectKind === 'team' && (folded === 'this team' || folded.length === 0)) {
    return {
      status: 'resolved',
      subjectKind: 'team',
      subjectKey: 'this-team',
      label: 'this team',
      confidence: CONFIDENCE.exact,
    };
  }

  const entities = await store.list(subjectKind);

  const byKey = entities.filter(
    (entity) =>
      fold(entity.naturalKey) === folded ||
      fold(String(entity.fields['itemKey'] ?? '')) === folded ||
      fold(String(entity.fields['name'] ?? '')) === folded,
  );

  if (byKey.length === 1) {
    const only = byKey[0] as StoredEntity;
    return {
      status: 'resolved',
      subjectKind,
      subjectKey: String(only.fields['itemKey'] ?? only.naturalKey),
      label: String(only.fields['itemKey'] ?? only.naturalKey),
      confidence: CONFIDENCE.exact,
    };
  }

  if (byKey.length > 1) {
    return ambiguousResolution(
      byKey.slice(0, MAX_CANDIDATES).map((entity) => ({
        subjectKind,
        subjectKey: String(entity.fields['itemKey'] ?? entity.naturalKey),
        label: String(entity.fields['itemKey'] ?? entity.naturalKey),
        reason: `a ${subjectKind} with this key`,
      })),
      hint,
    );
  }

  return {
    status: 'not_found',
    detail: `Compass has no ${subjectKind} called “${hint.trim()}”, so there is nothing for this memo to be about.`,
  };
}

/** Resolves whichever subject kind the assertion named. */
export function resolveSubject(
  store: KnowledgeStore,
  subjectKind: MemoSubjectKind,
  hint: string,
): Promise<SubjectResolution> {
  return subjectKind === 'developer'
    ? resolveDeveloperSubject(store, hint)
    : resolveKeyedSubject(store, subjectKind, hint);
}

/** True when a resolution may be persisted without asking the manager first. */
export const isConfident = (resolution: SubjectResolution): boolean =>
  resolution.status === 'resolved' && resolution.confidence >= SUBJECT_CONFIDENCE_THRESHOLD;
