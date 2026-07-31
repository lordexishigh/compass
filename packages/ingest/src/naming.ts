/**
 * Natural keys.
 *
 * A natural key is the identifier the *source* already uses, not one Compass
 * invents. That is the whole reason a second ingest of the same window is an
 * upsert rather than a duplicate, and the reason an item keeps its identity across
 * days so the report can say "day 6" instead of "new".
 *
 * Two families, deliberately spelled differently:
 *
 *  - Things humans say out loud keep their human key: a ticket is `CHK-701`, a
 *    project is `CHK`, a repository is `checkout-web`. Those strings appear in
 *    commit messages and in conversation, and a key that matched them would be
 *    unusable if it were a hash.
 *  - Things only a machine names are keyed `sourceKey:sourceRecordId` — sprints,
 *    pull requests, reviews. Records cross-reference each other by
 *    `sourceRecordId` (an issue's `sprintRefs`, a review's `pullRequestRef`), so
 *    keying them this way makes those references resolvable without a lookup
 *    table, and makes two configured sources unable to collide.
 *
 * A commit is the exception in both directions: its revision id *is* its identity
 * to the version control system, so the key is `repository@revision`. The same
 * commit reported by two mirrors of one repository is one row.
 */

export const projectNaturalKey = (projectKey: string): string => projectKey;

export const repositoryNaturalKey = (repositoryKey: string): string => repositoryKey;

/** A ticket is keyed by the tracker key a human types: `CHK-701`. */
export const ticketNaturalKey = (itemKey: string): string => itemKey;

/** A Feature is a parent work item, keyed the same way its ticket would be. */
export const featureNaturalKey = (itemKey: string): string => itemKey;

export const sprintNaturalKey = (sourceKey: string, sourceRecordId: string): string =>
  `${sourceKey}:${sourceRecordId}`;

export const pullRequestNaturalKey = (sourceKey: string, sourceRecordId: string): string =>
  `${sourceKey}:${sourceRecordId}`;

export const reviewNaturalKey = (sourceKey: string, sourceRecordId: string): string =>
  `${sourceKey}:${sourceRecordId}`;

export const commitNaturalKey = (repositoryKey: string, revisionId: string): string =>
  `${repositoryKey}@${revisionId}`;

export const branchRefNaturalKey = (repositoryKey: string, name: string): string => `${repositoryKey}:${name}`;

export const releaseTagNaturalKey = (repositoryKey: string, name: string): string => `${repositoryKey}:${name}`;

/**
 * A judgement is keyed by its subject and its cause — never by the report or the
 * run that surfaced it. That is what makes the same blocker on consecutive days
 * one row with a growing `last_seen_at`, which is what "day 6" is counted from.
 */
export const judgementNaturalKey = (subjectKind: string, subjectKey: string, cause: string): string =>
  `${subjectKind}:${subjectKey}:${cause}`;

/**
 * Tracker keys as they appear in prose: `CHK-701`, `PLAT-1234`.
 *
 * Two or more leading capitals so a bare `A-1` in a sentence is not mistaken for a
 * ticket, and a word boundary at each end so `WEB-12x` does not match. The pattern
 * is intentionally conservative: a false positive here would attribute a commit to
 * work it has nothing to do with, and the report would state that as fact.
 */
export const TICKET_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;

/**
 * The first tracker key named in a commit message, or null.
 *
 * Null is a real answer, not a failure: the report says "3 commits could not be
 * tied to a sprint objective" as a question, in the product's own voice, rather
 * than guessing which ticket the author meant.
 */
export function firstTicketKey(text: string): string | null {
  TICKET_KEY_PATTERN.lastIndex = 0;
  const match = TICKET_KEY_PATTERN.exec(text);
  return match?.[0] ?? null;
}

/** Every distinct tracker key named in a piece of text, in order of appearance. */
export function ticketKeysIn(text: string): readonly string[] {
  TICKET_KEY_PATTERN.lastIndex = 0;
  const found = new Set<string>();
  for (const match of text.matchAll(TICKET_KEY_PATTERN)) {
    if (match[0] !== undefined) found.add(match[0]);
  }
  return [...found];
}
