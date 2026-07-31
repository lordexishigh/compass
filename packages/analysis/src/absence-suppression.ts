import {
  entitiesAt,
  resolvedNumber,
  resolvedText,
  type ConfigSnapshot,
  type FieldsAtInstant,
} from './configuration.js';
import { compareStable, type Instant } from './instant.js';

/**
 * The stalled-work suppression rule. **The only implementation of it.**
 *
 * A ticket that has not moved for four working days is a finding worth reporting — unless
 * the person it is assigned to is on leave, in which case it is not news, it is arithmetic.
 * Reporting it anyway is the specific way an automated manager loses a reader's trust: the
 * first time Compass says "DEV-402 has not moved for 4 working days" about somebody who
 * booked the week off, the manager learns that Compass does not know things it should, and
 * every other finding is discounted from then on.
 *
 * ## Why exactly one module
 *
 * `alpha-configuration-and-identity-roster-004` requires the rule to live in one place, and
 * `tools/quality-gates/tests/roster-single-writer.test.ts` asserts it by scanning the
 * workspace. The reason is not tidiness. There are at least four detectors that could
 * suppress — stalled tickets, review waits, changes-requested stalls, stale statuses — and
 * four copies of "is this person out" would drift the moment one of them learned about a
 * new absence kind. One predicate, four callers.
 *
 * ## Suppression, not deduction
 *
 * An absence is **not** subtracted from the elapsed count. "Has not moved for 4 working
 * days" stays 4, because that is the number a manager can verify on the board, and a
 * shortened number Compass could not explain would be worse than a suppressed finding.
 * What changes is whether the finding is *stated*, and a suppressed finding carries its
 * reason and a link to the Absence that caused it — so the manager can see that Compass
 * knew, rather than wondering whether it noticed.
 */

export type AbsenceSource = 'manual' | 'memo';

/** One absence, resolved as of the report instant. */
export interface ActiveAbsence {
  readonly naturalKey: string;
  readonly developerKey: string;
  /** `leave`, `holiday`, `on_call` — the manager's own word, stated verbatim. */
  readonly kind: string;
  readonly startAt: Instant;
  readonly endAt: Instant;
  readonly note: string | null;
  readonly source: AbsenceSource;
  /** For a memo-sourced absence, the ManagerMemo key the report links to. */
  readonly sourceRef: string | null;
}

const toActiveAbsence = (resolved: FieldsAtInstant): ActiveAbsence | null => {
  const developerKey = resolvedText(resolved, 'developerKey');
  const startAt = resolvedNumber(resolved, 'startAt');
  const endAt = resolvedNumber(resolved, 'endAt');
  if (developerKey === null || startAt === null || endAt === null) return null;

  const source = resolvedText(resolved, 'source');

  return {
    naturalKey: resolved.naturalKey,
    developerKey,
    kind: resolvedText(resolved, 'absenceKind') ?? 'leave',
    startAt: startAt as Instant,
    endAt: endAt as Instant,
    note: resolvedText(resolved, 'note'),
    // An absence written before `source` existed is a manual one — that is what the
    // migration backfilled and what the roster provisioning path had always meant.
    source: source === 'memo' ? 'memo' : 'manual',
    sourceRef: resolvedText(resolved, 'sourceRef'),
  };
};

/**
 * Whether an absence covers an instant. **The predicate, in one expression.**
 *
 * Half-open `[startAt, endAt)`, matching every other span in the product: an absence that
 * ends at 09:00 does not cover 09:00. Exported because two callers need the same answer —
 * the detectors, through `absenceIndex` below, and the roster screen's "in force" mark. A
 * second copy for the screen would be a second copy that could disagree with the report,
 * and a screen that says somebody is out while the report names them is worse than either
 * one alone.
 *
 * Takes a structural shape rather than `ActiveAbsence`, so a caller holding a plain row
 * from the roster read model can use it without constructing one.
 */
export const absenceCoversInstant = (
  absence: { readonly startAt: number; readonly endAt: number },
  instant: Instant,
): boolean => instant >= absence.startAt && instant < absence.endAt;

/**
 * Every absence covering an instant, by developer.
 *
 * Built once per report and passed to the detectors, so the version history is walked once
 * rather than per finding.
 */
export function absencesAt(snapshot: ConfigSnapshot, instant: Instant): ReadonlyMap<string, readonly ActiveAbsence[]> {
  const byDeveloper = new Map<string, ActiveAbsence[]>();

  for (const resolved of entitiesAt(snapshot, 'absence', instant)) {
    const absence = toActiveAbsence(resolved);
    if (absence === null) continue;
    if (!absenceCoversInstant(absence, instant)) continue;

    const bucket = byDeveloper.get(absence.developerKey);
    if (bucket === undefined) byDeveloper.set(absence.developerKey, [absence]);
    else bucket.push(absence);
  }

  // Sorted so a person with two overlapping absences yields the same reason every run.
  for (const bucket of byDeveloper.values()) {
    bucket.sort((left, right) =>
      left.startAt === right.startAt ? compareStable(left.naturalKey, right.naturalKey) : left.startAt - right.startAt,
    );
  }

  return byDeveloper;
}

/**
 * An index that answers the suppression question and nothing else.
 *
 * Deliberately a small object rather than a bare map, so the call site reads as the rule
 * being applied — `absences.suppresses(assignee)` — rather than as a lookup a reader has to
 * interpret.
 */
export interface AbsenceIndex {
  /** The absence to blame, or null when the finding should be stated as normal. */
  suppressing(developerKey: string | null | undefined): ActiveAbsence | null;
  /** True when at least one absence covers the instant, for a masthead note. */
  readonly any: boolean;
  readonly all: readonly ActiveAbsence[];
}

export const EMPTY_ABSENCE_INDEX: AbsenceIndex = Object.freeze({
  suppressing: () => null,
  any: false,
  all: [] as readonly ActiveAbsence[],
});

export function absenceIndex(snapshot: ConfigSnapshot, instant: Instant): AbsenceIndex {
  const byDeveloper = absencesAt(snapshot, instant);
  if (byDeveloper.size === 0) return EMPTY_ABSENCE_INDEX;

  const all = [...byDeveloper.values()].flat().sort((left, right) =>
    left.developerKey === right.developerKey
      ? compareStable(left.naturalKey, right.naturalKey)
      : compareStable(left.developerKey, right.developerKey),
  );

  return {
    suppressing: (developerKey) => {
      // An unassigned or unattributed item is never suppressed. "Nobody is named, so
      // nobody is out" is the only defensible reading: suppressing it would hide a
      // genuinely stalled ticket behind somebody else's holiday.
      if (developerKey === null || developerKey === undefined || developerKey.length === 0) return null;
      return byDeveloper.get(developerKey)?.[0] ?? null;
    },
    any: true,
    all,
  };
}

/**
 * The sentence a suppressed finding is replaced by.
 *
 * In the product's own voice, naming the person's absence rather than the person's failure,
 * and citing the source so the claim is checkable. This is the "state the reason with a
 * link to the Absence source" half of the acceptance criterion; `sourceLabel` is what the
 * renderer turns into that link.
 */
export interface SuppressionNote {
  readonly developerKey: string;
  readonly absenceKey: string;
  readonly reason: string;
  /** `roster` or the memo's own key — what the evidence link points at. */
  readonly sourceLabel: string;
  readonly source: AbsenceSource;
}

export function describeSuppression(
  absence: ActiveAbsence,
  developerName: string | null,
): SuppressionNote {
  const who = developerName ?? absence.developerKey;
  const stated = absence.kind.replace(/_/g, ' ');
  const because =
    absence.source === 'memo'
      ? 'from a manager memo'
      : 'recorded in the roster';

  return {
    developerKey: absence.developerKey,
    absenceKey: absence.naturalKey,
    reason:
      `Not reported: ${who} is marked ${stated} for this date` +
      (absence.note === null || absence.note.length === 0 ? '' : ` (${absence.note})`) +
      `, ${because}.`,
    sourceLabel: absence.source === 'memo' ? (absence.sourceRef ?? 'manager memo') : 'roster',
    source: absence.source,
  };
}

/**
 * What a report suppressed, so the count can be stated rather than the items vanishing.
 *
 * A section that quietly loses three items looks like a section with nothing to say. The
 * masthead states the number and the reason instead — which is the same honest-degradation
 * rule the missing deploy signal follows.
 */
export interface SuppressionLedger {
  readonly notes: readonly SuppressionNote[];
  readonly count: number;
}

export function suppressionLedger(notes: readonly SuppressionNote[]): SuppressionLedger {
  const seen = new Set<string>();
  const unique: SuppressionNote[] = [];

  for (const note of notes) {
    const key = `${note.developerKey}:${note.absenceKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(note);
  }

  return { notes: unique, count: notes.length };
}
