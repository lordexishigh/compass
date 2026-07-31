import { orderedEvidence, type EvidenceRef } from './evidence.js';
import { compareNumbers, compareStable, workingDaysBetween, type Instant } from './instant.js';
import { rungAtOrAbove, type HighestRung, type LadderRungId } from './ladder.js';
import { developerName, instantField, numberField, textField, type AnalysisSnapshot } from './snapshot.js';
import { THRESHOLDS, thresholdRef, type ThresholdRef } from './thresholds.js';
import type { YesterdayItem } from './yesterday.js';

/**
 * Wins.
 *
 * The Wins section has one job and one failure mode. Its job is to make sure real
 * achievement is not invisible in a report that spends five sections on problems.
 * Its failure mode is congratulating people for nothing, which is worse than
 * silence: a manager who reads "Win: CHK-812 moved to Done" about a one-line
 * config change learns that this section is decoration and stops reading it.
 *
 * So a win is a *rule*, numbered and stated:
 *
 * > **W1.** A win is emitted when a unit of work crossed completion rung **R2
 * > (merged) or higher** inside the report window, **and** it was substantial —
 * > either its estimate was **`T8a` story points or more**, or it had been alive
 * > for **`T8b` working days or more**.
 *
 * Every clause is there for a reason.
 *
 * *R2 or higher* is measured against the ladder's **contiguous** rung, not its
 * highest crossed one, and that distinction is the whole rule. `INS-204`
 * transitions to Done with no branch, no pull request and no commit anywhere in
 * the dataset — it crosses R3 while R1 and R2 stay empty. Read as "highest rung
 * crossed" that is R3 and would be a win; read as "reached R2 without skipping
 * anything" it is R0 and is not. The second reading is the correct one, because
 * a tracker transition with nothing in version control behind it is the pathology
 * `done-with-no-pull-request-INS-204` exists to expose. It is a finding, not an
 * achievement.
 *
 * *Inside the window* keeps yesterday's wins out of today's report. And the
 * substantiality test has two limbs because a team that does not estimate would
 * otherwise never have a win: elapsed age is the fallback measure of "this was
 * not trivial", and it is available for every item.
 *
 * The rule is deliberately conservative. Compass would rather miss a modest win
 * than hand a manager a section they learn to skip.
 */
export const WIN_MINIMUM_RUNG: LadderRungId = 'R2';

export type WinQualifier = 'story_points' | 'elapsed_age' | 'both';

export interface DetectedWin {
  readonly stableId: string;
  /** The tracker key, when the unit of work has one. */
  readonly ticketKey: string | null;
  readonly unitOfWork: string;
  readonly title: string;
  /** The rung that was crossed, and its label — `R2 merged`, `R4 released`. */
  readonly rung: HighestRung;
  readonly rungLabel: string;
  readonly crossedAt: number;
  readonly points: number | null;
  readonly ageWorkingDays: number;
  readonly qualifiedBy: WinQualifier;
  /** Both limbs of W1, so the rule that fired is legible in the output. */
  readonly thresholds: readonly ThresholdRef[];
  readonly minimumRung: LadderRungId;
  readonly creditedDeveloperKey: string | null;
  readonly creditedName: string | null;
  readonly headline: string;
  readonly detail: string;
  readonly evidence: readonly EvidenceRef[];
}

/**
 * Applies rule W1 to the Yesterday items.
 *
 * Wins are derived from Yesterday rather than recomputed, which is what
 * guarantees the two sections cannot contradict each other: a win is always an
 * item the manager can also find above it, with the same artifacts and the same
 * ladder.
 */
export function detectWins(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  items: readonly YesterdayItem[],
): readonly DetectedWin[] {
  const wins: DetectedWin[] = [];

  for (const item of items) {
    if (!rungAtOrAbove(item.ladder.highestContiguous, WIN_MINIMUM_RUNG)) continue;

    const ticket =
      item.ticketKey === null
        ? null
        : (snapshot.collections.entities.find(
            (entity) => entity.kind === 'ticket' && textField(entity, 'itemKey') === item.ticketKey,
          ) ?? null);

    const points = ticket === null ? null : numberField(ticket, 'estimatePoints');
    const openedAt =
      ticket === null
        ? null
        : (instantField(ticket, 'createdAt') ?? (ticket.firstSeenAt as Instant));
    const ageWorkingDays = openedAt === null ? 0 : workingDaysBetween(openedAt, instant);

    const bigEnough = points !== null && points >= THRESHOLDS.T8a.value;
    const oldEnough = ageWorkingDays >= THRESHOLDS.T8b.value;
    if (!bigEnough && !oldEnough) continue;

    // The rung a win reports is the contiguous one — the highest point in an
    // unbroken chain of evidence. Reporting the highest *crossed* rung would let
    // a win claim "released" on the strength of a tag while the merge below it
    // was never observed.
    const qualifying = item.ladder.notches.find((notch) => notch.rung === item.ladder.highestContiguous);
    const rungLabel = `${item.ladder.highestContiguous} ${qualifying?.label ?? ''}`.trim();

    wins.push({
      stableId: `win:${item.unitOfWork}`,
      ticketKey: item.ticketKey,
      unitOfWork: item.unitOfWork,
      title: item.title,
      rung: item.ladder.highestContiguous,
      rungLabel,
      crossedAt: qualifying?.crossedAt ?? item.completedAt,
      points,
      ageWorkingDays,
      qualifiedBy: bigEnough && oldEnough ? 'both' : bigEnough ? 'story_points' : 'elapsed_age',
      thresholds: [thresholdRef('T8a'), thresholdRef('T8b')],
      minimumRung: WIN_MINIMUM_RUNG,
      creditedDeveloperKey: item.assigneeDeveloperKey,
      creditedName: developerName(snapshot, item.assigneeDeveloperKey),
      headline: `${item.ticketKey ?? item.unitOfWork} reached ${rungLabel}${item.title.length > 0 ? ` — ${item.title}` : ''}`,
      detail: winDetail(item.ticketKey, rungLabel, points, ageWorkingDays, bigEnough, oldEnough),
      evidence: orderedEvidence(item.artifacts),
    });
  }

  return wins.sort(
    (left, right) => compareNumbers(right.crossedAt, left.crossedAt) || compareStable(left.stableId, right.stableId),
  );
}

function winDetail(
  ticketKey: string | null,
  rungLabel: string,
  points: number | null,
  ageWorkingDays: number,
  bigEnough: boolean,
  oldEnough: boolean,
): string {
  const subject = ticketKey ?? 'This work';
  const size =
    bigEnough && points !== null
      ? `an estimate of ${points} points, at or above W1's ${THRESHOLDS.T8a.value}`
      : `${ageWorkingDays} working days of elapsed age, at or above W1's ${THRESHOLDS.T8b.value}`;
  const both =
    bigEnough && oldEnough && points !== null
      ? ` It also carried ${points} story points.`
      : '';

  return `${subject} crossed ${rungLabel} inside this window and qualifies under rule W1 on ${size}.${both}`;
}
