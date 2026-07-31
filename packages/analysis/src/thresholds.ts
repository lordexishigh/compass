/**
 * The numbered thresholds.
 *
 * Every judgement Compass makes is a threshold crossing, and a manager is
 * entitled to argue with the number. So each one is declared here once, given an
 * id, and carried *into the output* alongside the claim it produced — a blocker
 * says "T1, three working days of dwell", not "stalled". Nothing in this package
 * may compare against a bare literal; the detectors read these constants, and
 * `tests/determinism.test.ts` fails if a threshold is declared and never applied.
 *
 * `T0` exists so the invariant holds for judgements that apply no threshold at
 * all: the tracker said blocked, so Compass says blocked. That is still a named,
 * citable rule — it just has no number to tune.
 */
export type ThresholdId =
  | 'T0'
  | 'T1'
  | 'T2'
  | 'T3'
  | 'T4'
  | 'T5'
  | 'T6'
  | 'T7'
  | 'T8a'
  | 'T8b'
  | 'T9'
  | 'T10'
  | 'T11'
  | 'T12'
  | 'T13'
  | 'T14'
  | 'T15'
  | 'T16'
  | 'T17';

export interface Threshold {
  readonly id: ThresholdId;
  /** The comparison value. Zero for `T0`, which applies none. */
  readonly value: number;
  readonly unit:
    | 'none'
    | 'working_days'
    | 'days'
    | 'count'
    | 'story_points'
    | 'basis_points'
    | 'sample_size';
  /** How the rule reads in the report, in the product's own voice. */
  readonly statement: string;
}

const define = (
  id: ThresholdId,
  value: number,
  unit: Threshold['unit'],
  statement: string,
): Threshold => Object.freeze({ id, value, unit, statement });

export const THRESHOLDS = Object.freeze({
  /** No threshold: the source stated the condition outright. */
  T0: define('T0', 0, 'none', 'The source states this outright, so no threshold is applied.'),

  T1: define(
    'T1',
    3,
    'working_days',
    'A work item that has not changed status for three working days while neither done nor waiting to start.',
  ),
  T2: define('T2', 1, 'working_days', 'An open pull request with no requested reviewer after one working day.'),
  T3: define(
    'T3',
    2,
    'working_days',
    'A pull request whose latest review asked for changes, with no push and no new review for two working days.',
  ),
  T4: define('T4', 2, 'working_days', 'An open pull request awaiting its first review for two working days.'),
  T5: define('T5', 3, 'count', 'Three or more open pull requests waiting on the same named reviewer.'),
  T6: define('T6', 3, 'count', 'Three or more items added to a sprint after it started.'),

  T7: define('T7', 2, 'sample_size', 'Velocity, its trend and any projection need two completed sprints.'),

  /** The two limbs of the win rule. Both are documented; either limb suffices. */
  T8a: define('T8a', 3, 'story_points', 'A win needs an estimate of three story points or more…'),
  T8b: define('T8b', 5, 'working_days', '…or five working days of elapsed age, for unestimated work.'),

  T9: define(
    'T9',
    3,
    'count',
    'Tech debt is growing when the open tech-debt count rose by three or more over the trailing four weeks.',
  ),
  T10: define(
    'T10',
    2_000,
    'basis_points',
    'Rework is elevated when a fifth or more of merged pull requests needed three or more changes-requested cycles.',
  ),

  T11: define('T11', 21, 'days', 'Open tech-debt work is stale when its mean age passes three weeks.'),

  T12: define(
    'T12',
    3_000,
    'basis_points',
    'Story points are uninformative when their correlation with elapsed days falls below 0.30.',
  ),
  T13: define('T13', 10, 'sample_size', 'A calibration verdict needs ten completed, estimated items.'),
  T14: define(
    'T14',
    4_000,
    'basis_points',
    'Work is concentrated when one person holds two fifths or more of the open in-flight items.',
  ),

  T15: define(
    'T15',
    8_000,
    'basis_points',
    'Completion is measured in story points only when four fifths or more of the sprint scope carries an estimate; otherwise it is measured in items.',
  ),

  T16: define(
    'T16',
    3,
    'count',
    'Three or more merged pull requests sitting ahead of the newest release tag is unreleased work worth naming.',
  ),

  /**
   * The alignment confidence threshold — the one number that decides whether
   * Compass states a verdict or asks a question.
   *
   * It is a Sørensen–Dice coefficient over normalised token sets, expressed in
   * basis points like every other ratio here, and it is deliberately low: 0.30 is
   * about three shared words out of ten, which is roughly where a commit message
   * stops coincidentally resembling a goal. Below it nothing is labelled at all —
   * the work goes in the `unattributed` bucket and is rendered as a question — so
   * the cost of setting it too high is a larger bucket and the cost of setting it
   * too low is a wrong accusation. Compass errs toward the bucket.
   */
  T17: define(
    'T17',
    3_000,
    'basis_points',
    'Alignment is attributed semantically only when the shared-vocabulary score reaches 0.30; below that the work is unattributed and Compass asks rather than states.',
  ),
} as const satisfies Record<ThresholdId, Threshold>);

/** A threshold as it appears attached to a claim in the report. */
export interface ThresholdRef {
  readonly id: ThresholdId;
  readonly value: number;
  readonly unit: Threshold['unit'];
  readonly statement: string;
}

export function thresholdRef(id: ThresholdId): ThresholdRef {
  const threshold = THRESHOLDS[id];
  return { id: threshold.id, value: threshold.value, unit: threshold.unit, statement: threshold.statement };
}

export const THRESHOLD_IDS = Object.freeze(Object.keys(THRESHOLDS) as readonly ThresholdId[]);
