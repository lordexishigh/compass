/**
 * The interpretation-template set.
 *
 * Compass never prints a number on its own. A manager reading "62%" learns
 * nothing they could act on; a manager reading "62%, which is behind the pace
 * the elapsed schedule implies" has been told something. So the deterministic
 * renderer has one hard rule, and this file is that rule made checkable:
 *
 * > **Every sentence that states a quantity also contains a clause instantiated
 * > from one of the templates below.**
 *
 * The rule is enforced twice over, deliberately:
 *
 *  1. **At render time.** `plainSentence` in `prose.ts` throws
 *     `UngroundedNumberError` if a sentence it was asked to emit carries a
 *     quantity with no clause. The renderer fails closed rather than shipping an
 *     uninterpreted metric.
 *  2. **At test time.** `tests/prose.test.ts` renders a real report, tokenises it
 *     with `extractNumericTokens` — the *same* extractor the grounding validator
 *     uses, imported from `@compass/analysis`, never re-implemented — and asserts
 *     that every sentence carrying a token matches one of the `pattern`s here.
 *
 * A template is a triple: a `render` function the renderer calls, a `pattern`
 * that recognises what `render` produced, and an `example` that documents it.
 * `tests/interpretation-templates.test.ts` asserts every `example` matches its
 * own `pattern`, so the documentation cannot drift away from the code that reads
 * it — the same arrangement `DETERMINISM.md` uses for the non-semantic field list.
 *
 * Adding a template is a deliberate act: it is a new way Compass is allowed to
 * explain a number, and it belongs in code review rather than in a prompt.
 */

export const INTERPRETATION_TEMPLATE_IDS = [
  'pace',
  'rate',
  'ladder',
  'threshold',
  'held',
  'severity',
  'step',
  'elapsed',
  'evidence',
  'change',
  'sectionCount',
  'coverage',
  'collar',
  'aging',
  'alignment',
  'unattributed',
  'calibration',
  'movement',
  'accepted',
  'resurfaced',
] as const;

export type InterpretationTemplateId = (typeof INTERPRETATION_TEMPLATE_IDS)[number];

export interface InterpretationTemplateDefinition {
  readonly id: InterpretationTemplateId;
  /** What kind of number this clause is allowed to explain. */
  readonly purpose: string;
  /** One instantiation, in full. Asserted to match `pattern`. */
  readonly example: string;
  /** Recognises a clause this template produced. */
  readonly pattern: RegExp;
}

export interface InterpretationClause {
  readonly templateId: InterpretationTemplateId;
  readonly text: string;
}

const clause = (templateId: InterpretationTemplateId, text: string): InterpretationClause => ({ templateId, text });

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  count === 1 ? singular : pluralForm;

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

export const INTERPRETATION_TEMPLATES: readonly InterpretationTemplateDefinition[] = Object.freeze([
  {
    id: 'pace',
    purpose:
      'A sprint completion percentage. Read against the share of the sprint schedule already spent, which is the only comparison that makes a percentage actionable.',
    example: 'which is behind the pace the elapsed schedule implies',
    pattern: /\bwhich is (?:ahead of|behind|level with) the pace the elapsed schedule implies\b/,
  },
  {
    id: 'rate',
    purpose:
      'A flow figure with no schedule to compare against — throughput, cycle time, velocity. Named as a measurement rather than dressed up as a target the team missed.',
    example: 'and that is the measured rate rather than a target',
    pattern: /\band that is the measured rate rather than a target\b/,
  },
  {
    id: 'ladder',
    purpose:
      'A completion. Says which rung of the Completion Ladder was actually reached, and whether anything below it was skipped, so "done" is never a single bit.',
    example: 'so it reached R2 merged and nothing above that',
    // The label alternation is an allowlist, not a convenience. It is what made the
    // Completion Ladder's rung rename a build failure rather than a silent
    // regression: a renderer emitting `R3 integrated` against a pattern that only
    // knew `accepted` would have thrown `UngroundedNumberError` for the whole
    // report, which is the correct fail-closed behaviour and the reason the two
    // vocabularies have to be edited together.
    pattern:
      /\bso (?:it reached R[1-5] (?:accepted|merged|integrated|released|deployed) (?:and nothing above that|with a rung skipped below it)|nothing it did crossed a completion rung)\b/,
  },
  {
    id: 'threshold',
    purpose:
      'A measurement that was compared against a documented threshold. Names the rule by its identifier so a manager can look up what Compass decided and argue with it.',
    // `T8a` and `T8b` are real threshold ids — the two limbs of the win rule — so
    // the identifier is `T`, digits, and an optional limb letter.
    example: 'because it crossed the threshold T8a sets',
    pattern: /\bbecause it (?:crossed|stayed inside) the threshold T\d+[a-z]? sets\b/,
  },
  {
    id: 'held',
    purpose:
      'A blocker duration. States how long the condition has held and, in the same breath, why that makes it a blocker rather than merely slow work.',
    example: 'so it has held for 6 days and is stated as a blocker rather than as slow progress',
    pattern:
      /\bso it (?:has held for \d+ days?|appeared today) and is stated as a blocker rather than as slow progress\b/,
  },
  {
    id: 'severity',
    purpose: 'A risk measurement. Carries the severity Compass assigned and the direction it is moving.',
    example: 'which Compass rates high severity and worsened',
    pattern: /\bwhich Compass rates (?:high|medium|low) severity and (?:new|worsened|unchanged|improving)\b/,
  },
  {
    id: 'step',
    purpose: 'A recommendation. Says it is one step and when it is finishable, so it cannot read as a project.',
    example: 'and it is one step, finishable today',
    pattern: /\band it is one step, finishable (?:today|this week)\b/,
  },
  {
    id: 'elapsed',
    purpose: 'A day counter on a recurring item. Turns a bare age into the elapsed fact the sigil states.',
    example: 'which makes today day 6 of it',
    pattern: /\bwhich makes today day \d+ of it\b/,
  },
  {
    id: 'evidence',
    purpose:
      'A claim whose only quantity is how much evidence stands behind it. Says the artifacts are openable, which is what makes the claim checkable.',
    example: 'traced to 3 artifacts you can open',
    pattern: /\btraced to \d+ artifacts? you can open\b/,
  },
  {
    id: 'change',
    purpose:
      'The terminal fallback: a claim with nothing quantitative to interpret. States how Compass classified it against yesterday.',
    example: 'and Compass records it as unchanged',
    pattern: /\band Compass records it as (?:new|unchanged|worsened|improved|resolved)\b/,
  },
  {
    id: 'sectionCount',
    purpose: "A section's own item count, in its lead sentence.",
    example: 'so this section carries 4 items',
    pattern: /\bso this section carries \d+ items?\b/,
  },
  {
    id: 'coverage',
    purpose:
      'The freshness line. Turns a source count into the only thing that matters about it: whether the report in front of the reader is complete.',
    example: 'so 1 of 4 configured sources did not answer and this report is not complete',
    pattern:
      /\bso (?:every configured source answered and this report is complete|\d+ of \d+ configured sources did not answer and this report is not complete|no source answered and this report is not a complete picture)\b/,
  },
  {
    id: 'collar',
    purpose:
      'The projected completion date. The confidence collar: the band, the method behind it, and how well the team calibrates — so the date is never read as a promise.',
    example: 'and the collar on that date is low confidence from cycle time',
    pattern: /\band the collar on that date is (?:low|medium|high) confidence from (?:trailing velocity|cycle time)\b/,
  },
  {
    id: 'aging',
    purpose:
      "An item still in flight past this board's own measured P85 cycle time. Names the baseline as a measurement of the team's own history rather than a deadline, because a Kanban team never committed to a date and must not be read as having missed one.",
    example: 'and that is measured against the 8-day P85 this board finished its own work in',
    pattern: /\band that is measured against the \d+-day P85 this board finished its own work in\b/,
  },
  {
    id: 'alignment',
    purpose:
      'An alignment verdict. Names the tier that actually resolved it and the confidence against the threshold it was compared with, so an OFF-GOAL flag arrives as an argument a manager can check rather than as a pronouncement.',
    example: 'so Compass resolved this semantically at 0.62 confidence against the 0.30 threshold T17 sets',
    pattern:
      /\bso Compass resolved this (?:through a configured chain|from an inferred tracker key|semantically) at \d\.\d{2} confidence against the \d\.\d{2} threshold T\d+[a-z]? sets\b/,
  },
  {
    id: 'unattributed',
    purpose:
      'Work Compass could not tie to a goal. Turns the count into a question rather than a finding — low-confidence attribution phrased as a verdict against a named developer is the one mistake that ends adoption of a product like this.',
    example: 'so Compass is asking what they served rather than naming anyone',
    pattern: /\bso Compass is asking what (?:it|they) served rather than naming anyone\b/,
  },
  {
    id: 'calibration',
    purpose:
      'A Process Calibration Audit statistic. Says the number is a measurement of the *data* rather than of the team, and names the verdict it produced — because "your carryover is 50%" reads as an accusation until it is attached to the reason Compass is measuring it at all.',
    example: 'which is a measurement of the data behind this report, and it reached scope_is_fiction',
    pattern:
      /\bwhich is a measurement of the data behind this report, and it (?:reached [a-z_, ]+|found nothing worth withholding a number for)\b/,
  },
  {
    id: 'movement',
    purpose:
      "The report's own change line. Turns the counts of what moved into the only thing they are for: telling a manager which part of this page is worth re-reading, and which part they have already read.",
    example: 'which is what moved since the previous report, and the rest is carried over',
    pattern: /\bwhich is what moved since the previous report, and the rest is carried over\b/,
  },
  {
    id: 'accepted',
    purpose:
      "A step the manager already took. The date is the receipt: it says Compass is showing the item as their decision rather than re-suggesting something they have acted on.",
    example: 'and Compass is showing your own decision of 2026-07-30 rather than suggesting it again',
    pattern: /\band Compass is showing your own decision of \d{4}-\d{2}-\d{2} rather than suggesting it again\b/,
  },
  {
    id: 'resurfaced',
    purpose:
      'A dismissed risk that has come back. Names the severity movement in points against the documented threshold, because "back because it got worse" is a sentence a manager cannot argue with and every claim in Compass has to be arguable.',
    example: 'because its severity rose 120 points against the 100 a return requires',
    pattern: /\bbecause its severity rose \d+ points against the \d+ a return requires\b/,
  },
]);

const BY_ID: ReadonlyMap<InterpretationTemplateId, InterpretationTemplateDefinition> = new Map(
  INTERPRETATION_TEMPLATES.map((template) => [template.id, template]),
);

export function interpretationTemplate(id: InterpretationTemplateId): InterpretationTemplateDefinition {
  const template = BY_ID.get(id);
  if (!template) throw new Error(`\`${id}\` is not a documented interpretation template.`);
  return template;
}

/** The first documented template a sentence instantiates, or null. */
export function interpretationClauseIn(sentence: string): InterpretationTemplateDefinition | null {
  return INTERPRETATION_TEMPLATES.find((template) => template.pattern.test(sentence)) ?? null;
}

// ---------------------------------------------------------------------------
// Instantiation — the only way the renderer is allowed to produce a clause
// ---------------------------------------------------------------------------

export type PaceVerdict = 'ahead of' | 'behind' | 'level with';

export const interpretation = {
  pace: (verdict: PaceVerdict): InterpretationClause =>
    clause('pace', `which is ${verdict} the pace the elapsed schedule implies`),

  rate: (): InterpretationClause => clause('rate', 'and that is the measured rate rather than a target'),

  ladder: (rung: string, label: string | null, contiguous: boolean): InterpretationClause => {
    if (rung === 'R0' || label === null) {
      return clause('ladder', 'so nothing it did crossed a completion rung');
    }
    return clause(
      'ladder',
      `so it reached ${rung} ${label} ${contiguous ? 'and nothing above that' : 'with a rung skipped below it'}`,
    );
  },

  threshold: (thresholdId: string, crossed: boolean): InterpretationClause =>
    clause('threshold', `because it ${crossed ? 'crossed' : 'stayed inside'} the threshold ${thresholdId} sets`),

  held: (ageDays: number): InterpretationClause =>
    clause(
      'held',
      ageDays <= 0
        ? 'so it appeared today and is stated as a blocker rather than as slow progress'
        : `so it has held for ${ageDays} ${plural(ageDays, 'day')} and is stated as a blocker rather than as slow progress`,
    ),

  severity: (severity: string, trend: string): InterpretationClause =>
    clause('severity', `which Compass rates ${severity} severity and ${trend}`),

  step: (urgency: 'today' | 'this week'): InterpretationClause =>
    clause('step', `and it is one step, finishable ${urgency}`),

  elapsed: (ageDays: number): InterpretationClause => clause('elapsed', `which makes today day ${ageDays} of it`),

  evidence: (count: number): InterpretationClause =>
    clause('evidence', `traced to ${count} ${plural(count, 'artifact')} you can open`),

  change: (changeTag: string): InterpretationClause => clause('change', `and Compass records it as ${changeTag}`),

  sectionCount: (count: number): InterpretationClause =>
    clause('sectionCount', `so this section carries ${count} ${plural(count, 'item')}`),

  coverage: (answered: number, total: number): InterpretationClause => {
    if (total === 0 || answered === 0) {
      return clause('coverage', 'so no source answered and this report is not a complete picture');
    }
    if (answered >= total) {
      return clause('coverage', 'so every configured source answered and this report is complete');
    }
    return clause(
      'coverage',
      `so ${total - answered} of ${total} configured sources did not answer and this report is not complete`,
    );
  },

  collar: (confidence: 'low' | 'medium' | 'high', method: 'trailing_velocity' | 'cycle_time'): InterpretationClause =>
    clause(
      'collar',
      `and the collar on that date is ${confidence} confidence from ${
        method === 'trailing_velocity' ? 'trailing velocity' : 'cycle time'
      }`,
    ),

  /**
   * The aging clause: the P85 the item is late against, named as a measurement.
   *
   * "8-day P85 this board finished its own work in" rather than "8-day target", because
   * the number is the team's own observed distribution and calling it a target would
   * invent a commitment nobody made. A Kanban team has no dates to miss, which is the
   * whole reason `KanbanFlow` carries no percentage.
   */
  aging: (p85Days: number): InterpretationClause =>
    clause('aging', `and that is measured against the ${p85Days}-day P85 this board finished its own work in`),

  /**
   * Both numbers, always, in the same clause.
   *
   * A confidence with no threshold beside it invites the reader to guess what it
   * was compared against, and the whole safety argument for OFF-GOAL rests on that
   * comparison being visible. Two decimal places rather than the stored four: the
   * score is quotable at two, and a seventeen-digit float in a sentence reads as a
   * machine talking to itself.
   */
  alignment: (
    tier: 'configured' | 'inferred' | 'semantic',
    confidence: number,
    threshold: number,
    thresholdId: string,
  ): InterpretationClause =>
    clause(
      'alignment',
      `so Compass resolved this ${
        tier === 'configured' ? 'through a configured chain' : tier === 'inferred' ? 'from an inferred tracker key' : 'semantically'
      } at ${confidence.toFixed(2)} confidence against the ${threshold.toFixed(2)} threshold ${thresholdId} sets`,
    ),

  unattributed: (count: number): InterpretationClause =>
    clause('unattributed', `so Compass is asking what ${count === 1 ? 'it' : 'they'} served rather than naming anyone`),

  /**
   * The Process Calibration Audit's clause.
   *
   * Two things at once, and both are load-bearing. It says the figure is about the
   * *data* — a carryover rate is a statement about how a commitment was recorded,
   * not about how hard anyone worked — and it names the verdicts, so the reader can
   * see whether the number crossed a threshold or is merely being reported.
   */
  calibration: (verdicts: readonly string[]): InterpretationClause =>
    clause(
      'calibration',
      `which is a measurement of the data behind this report, and it ${
        verdicts.length === 0
          ? 'found nothing worth withholding a number for'
          : `reached ${[...verdicts].join(', ')}`
      }`,
    ),

  /** The change line's clause: what these counts are *for*. */
  movement: (): InterpretationClause =>
    clause('movement', 'which is what moved since the previous report, and the rest is carried over'),

  /** A step the manager already accepted, dated. Their decision, not a fresh suggestion. */
  accepted: (isoDate: string): InterpretationClause =>
    clause('accepted', `and Compass is showing your own decision of ${isoDate} rather than suggesting it again`),

  /** A dismissed risk that crossed the material-worsening threshold, in points. */
  resurfaced: (delta: number, threshold: number): InterpretationClause =>
    clause('resurfaced', `because its severity rose ${delta} points against the ${threshold} a return requires`),
} as const;
