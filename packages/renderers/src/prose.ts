import {
  MATERIAL_WORSENING_DELTA,
  PROGRESS_CAUSE_KINDS,
  SECTIONS,
  assertSixSectionsInOrder,
  extractNumericTokens,
  itemPresenceDays,
  sentencesWithNumbers,
  splitSentences,
  workingDaysBetween,
  type Instant,
  type ReportCoverageNote,
  type ReportItem,
  type ReportSection,
  type SectionKey,
  type StructuredReport,
} from '@compass/analysis';
import { formatCivilDate, formatCivilDateTime } from '@compass/clock';

import {
  interpretation,
  interpretationClauseIn,
  type InterpretationClause,
  type PaceVerdict,
} from './interpretation-templates.js';

/**
 * The deterministic template renderer.
 *
 * This is the MVP's only renderer, and it is also the permanent fallback: when
 * the Anthropic key is absent, or when the grounding validator rejects a
 * narration, this is what a manager reads. So it renders the whole report, not a
 * placeholder, and it renders it in the product's voice.
 *
 * Four properties hold, and each is asserted rather than intended.
 *
 * **Byte-identical.** Given the same structured report it emits the same bytes.
 * Nothing here reads a clock, generates an id, iterates a `Set` or sorts with
 * `localeCompare`; the instant is a field of the report it was handed.
 *
 * **Six sections, fixed order.** The order comes from `SECTIONS` in the analysis
 * package — the single definition the pipeline's row ordinals and the web view's
 * headings also read. `assertSixSectionsInOrder` runs first, so a tampered report
 * throws instead of rendering short.
 *
 * **Prose only.** No chart, no canvas, no svg, no table of metrics. Absence of
 * signal is a sentence.
 *
 * **No metric without an interpretation.** Every sentence in `prose` that states
 * a quantity also carries a clause instantiated from the documented set in
 * `interpretation-templates.ts`, and `plainSentence` throws if a caller tries to
 * emit one that does not. The renderer fails closed on an uninterpreted number
 * for the same reason narration does: a bare figure invites a manager to draw
 * their own conclusion from data they cannot see.
 *
 * ### What "prose" covers, and what it does not
 *
 * `RenderedReport.prose` is every sentence the renderer wrote. `text` is that
 * plus the page's furniture — the `01`–`06` section numerals of the Six Spine.
 * The interpretation rule is stated over `prose`: a fixed section index is not a
 * measurement and has nothing to interpret, and putting `01` under the rule would
 * only mean inventing a clause to explain the number one.
 *
 * ### Bounded length
 *
 * At most three sentences per item — the claim, the change since yesterday, the
 * evidence — plus one lead sentence per section. The structured payload keeps
 * every detail; the prose is what a manager reads over coffee, and length is the
 * one thing that decides whether they read it at all.
 */

export const RENDERER_ID = 'template';

/** Sentences per item. The claim, the change clause, the evidence chain. */
export const MAX_SENTENCES_PER_ITEM = 3;

export class UngroundedNumberError extends Error {
  readonly sentence: string;

  constructor(sentence: string, tokens: readonly string[]) {
    super(
      `The renderer was asked to emit "${sentence}", which states ${tokens
        .map((token) => `\`${token}\``)
        .join(', ')} with no interpretation. ` +
        'Every quantity in Compass prose carries a clause from the documented interpretation-template set.',
    );
    this.name = 'UngroundedNumberError';
    this.sentence = sentence;
  }
}

/**
 * One claim's own sentences, tied to the claim they are about.
 *
 * The web view needs this rather than the joined string: every computed claim
 * carries an evidence marker, and a marker can only be attached to a paragraph
 * whose claim is known. Splitting the section's prose back apart by index would
 * work until the day a renderer emitted a paragraph that was not an item, and
 * then it would silently attach one claim's evidence to another claim's
 * sentences — which is precisely the failure the evidence rule exists to prevent.
 */
export interface RenderedClaim {
  readonly stableId: string;
  readonly prose: string;
}

export interface RenderedSection {
  readonly key: SectionKey;
  /** 1–6. */
  readonly index: number;
  /** `01`–`06`. */
  readonly numeral: string;
  readonly title: string;
  /** The section's prose. No heading, no numeral — those belong to the page. */
  readonly prose: string;
  /** The lead sentence: the section's summary, or its stated absence. */
  readonly lead: string;
  /** One entry per item, in section order. */
  readonly claims: readonly RenderedClaim[];
  /** The confidence collar. Progress only; null everywhere else. */
  readonly trailer: string | null;
}

export interface RenderedReport {
  readonly rendererId: typeof RENDERER_ID;
  /** `Compass — platform — 2026-07-31`. */
  readonly masthead: string;
  /** What was ingested and what was not, in one or more sentences. */
  readonly freshness: string;
  /**
   * What moved since the previous report — the second line of the document, always.
   *
   * It sits above the six sections because it is what decides how the rest of the page is
   * read: "nothing material changed since yesterday" is the whole report on a quiet morning,
   * and a manager who has that sentence does not need to re-read six sections to discover it.
   * That is the failure this line exists to prevent — a page that re-lists yesterday's three
   * blockers in yesterday's voice and lets the reader work out for themselves that nothing
   * happened.
   */
  readonly changeLine: string;
  readonly sections: readonly RenderedSection[];
  /** Every sentence the renderer wrote. The interpretation rule holds here. */
  readonly prose: string;
  /** The whole document, section numerals included — the email and CLI form. */
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Sentence construction — the only way prose gets written
// ---------------------------------------------------------------------------

/**
 * One sentence out of possibly several.
 *
 * A structured `headline` or `detail` may be more than one sentence, and if the
 * renderer let it split, the half carrying the number would come apart from the
 * half carrying its meaning — which is precisely the failure the interpretation
 * rule exists to prevent. So the fact is flattened first: terminators become
 * semicolons, whitespace collapses, and the trailing full stop is dropped so the
 * clause can be appended.
 */
function flatten(fact: string): string {
  return splitSentences(fact.replace(/\s+/g, ' '))
    .map((sentence) => sentence.text.replace(/[.!?]+$/, '').trim())
    .filter((sentence) => sentence.length > 0)
    .join('; ');
}

/** A fact and the clause that says what it means, in one sentence. */
function groundedSentence(fact: string, clause: InterpretationClause): string {
  const flat = flatten(fact);
  return flat.length === 0 ? `${capitalize(clause.text)}.` : `${flat} — ${clause.text}.`;
}

/**
 * The render-time half of the interpretation rule.
 *
 * Every sentence that states a quantity must instantiate a documented clause.
 * With the sentence builders above, that holds by construction — which is the
 * point of routing all pass-through text through `statedSentence`. This guard
 * exists for the change that breaks the construction: somebody adds a sentence
 * builder, forgets the clause, and every existing test still passes because
 * every existing sentence is fine. Then the render throws with the offending
 * sentence quoted, rather than a manager reading a bare figure.
 *
 * It uses the same extractor the grounding validator uses, so narration and the
 * template renderer are held to one definition of "states a quantity".
 */
export function assertEveryQuantityInterpreted(prose: string): void {
  for (const { sentence, tokens } of sentencesWithNumbers(prose)) {
    if (interpretationClauseIn(sentence.text) === null) {
      throw new UngroundedNumberError(sentence.text, tokens.map((token) => token.text));
    }
  }
}

/** Plain when it can be, grounded when the fact turns out to carry a number. */
function statedSentence(fact: string, fallback: InterpretationClause): string {
  const flat = flatten(fact);
  if (flat.length === 0) return '';
  return extractNumericTokens(flat).length > 0 ? groundedSentence(flat, fallback) : `${flat}.`;
}

const capitalize = (text: string): string => (text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1));

const plural = (count: number, singular: string): string => (count === 1 ? singular : `${singular}s`);

// ---------------------------------------------------------------------------
// The masthead and the freshness line
// ---------------------------------------------------------------------------

const scopeLabel = (report: StructuredReport): string =>
  report.scope.kind === 'team' ? report.scope.teamKey : 'all teams';

export function renderMasthead(report: StructuredReport): string {
  return `Compass — ${scopeLabel(report)} — ${formatCivilDate(report.instant, report.timezone)}`;
}

const windowLabel = (report: StructuredReport): string =>
  `${formatCivilDateTime(report.window.start, report.timezone)} to ${formatCivilDateTime(
    report.window.end,
    report.timezone,
  )}`;

/**
 * The freshness line: which sources answered, which did not, and — always — what
 * that means for whether the report in front of the reader is complete.
 *
 * A degraded source is named in the connector's own words. Compass does not
 * paraphrase "rate limited" into something softer, and it never folds a silent
 * source into a clean total.
 */
export function renderFreshness(report: StructuredReport): string {
  const notes: readonly ReportCoverageNote[] = report.coverage;
  const answered = notes.filter((note) => note.status === 'complete');

  if (notes.length === 0) {
    return [
      groundedSentence(
        `Compass has no ingest record for ${windowLabel(report)}`,
        interpretation.coverage(0, 0),
      ),
    ].join(' ');
  }

  const sentences = [
    groundedSentence(
      `Compass read ${answered.length} of ${notes.length} configured ${plural(notes.length, 'source')} for ${windowLabel(
        report,
      )}`,
      interpretation.coverage(answered.length, notes.length),
    ),
  ];

  for (const note of notes) {
    if (note.status === 'complete') continue;
    sentences.push(statedSentence(note.detail, interpretation.coverage(answered.length, notes.length)));
  }

  return sentences.filter((sentence) => sentence.length > 0).join(' ');
}

// ---------------------------------------------------------------------------
// Choosing the clause for one claim
// ---------------------------------------------------------------------------

/**
 * The pace a completion percentage is read against.
 *
 * This is presentation arithmetic, not a new judgement: the share of the sprint
 * schedule already spent, using the analysis core's own `workingDaysBetween` over
 * the sprint bounds the core put in the payload. The renderer invents no
 * threshold — anything within five percentage points reads as level, which is the
 * width at which a manager should not act on the difference.
 */
function paceVerdict(completionPercent: number, elapsedWorkingDays: number, startAt: Instant, endAt: Instant): PaceVerdict {
  const totalWorkingDays = workingDaysBetween(startAt, endAt);
  if (totalWorkingDays <= 0) return 'level with';
  const expectedPercent = Math.round((elapsedWorkingDays / totalWorkingDays) * 100);
  const difference = completionPercent - expectedPercent;
  if (difference > 5) return 'ahead of';
  if (difference < -5) return 'behind';
  return 'level with';
}

/**
 * The clause a Progress figure gets, chosen by the item's *cause kind*.
 *
 * Matched on `item.cause.causeKind` rather than on a magic id string. That is the more honest
 * join — the question being asked is "what kind of figure is this", which is exactly what a
 * cause kind answers — and it survives the Progress ids becoming tenant-scoped digests, which
 * a comparison against `progress:velocity` did not.
 */
function progressClause(report: StructuredReport, item: ReportItem): InterpretationClause | null {
  const progress = report.findings.progress;
  const projection = report.findings.projection;
  const causeKind = item.cause.causeKind;

  if (causeKind === PROGRESS_CAUSE_KINDS.projection) {
    return projection.kind === 'projected'
      ? interpretation.collar(projection.band.confidence, projection.method)
      : interpretation.threshold(projection.threshold.id, false);
  }
  if (causeKind === PROGRESS_CAUSE_KINDS.velocity || causeKind === PROGRESS_CAUSE_KINDS.kanbanFlow) {
    return interpretation.rate();
  }
  if (progress.mode === 'sprint' && causeKind === PROGRESS_CAUSE_KINDS.sprint) {
    const sprint = progress.sprint;
    return interpretation.pace(
      paceVerdict(
        sprint.completionPercent,
        sprint.elapsedWorkingDays,
        sprint.startAt as Instant,
        sprint.endAt as Instant,
      ),
    );
  }
  return null;
}

/**
 * The clause one claim gets.
 *
 * Each section reads its own findings by `stableId` — the id is derived from the
 * entity and the cause, so the join is stable across days and across runs. The
 * fallback is terminal on purpose: evidence when there is any, otherwise the
 * change tag, both of which exist on every item. There is no path out of this
 * function that returns nothing.
 */
function clauseFor(report: StructuredReport, sectionKey: SectionKey, item: ReportItem): InterpretationClause {
  const findings = report.findings;

  // Alignment first, and by the field on the item rather than by a lookup into
  // findings: the resolution path travels with the claim, so the clause cannot
  // drift from the evidence panel printed beside it.
  const alignment = item.alignment;
  if (alignment !== undefined) {
    return alignment.resolvedTier === 'unattributed'
      ? interpretation.unattributed(alignment.subjectLabels.length)
      : interpretation.alignment(
          alignment.resolvedTier,
          alignment.confidence,
          alignment.threshold,
          alignment.thresholdId,
        );
  }

  switch (sectionKey) {
    case 'yesterday': {
      const ladder = item.ladder;
      if (ladder !== undefined) {
        return interpretation.ladder(
          ladder.highestCrossed,
          ladder.highestCrossedLabel,
          ladder.highestContiguous === ladder.highestCrossed,
        );
      }
      break;
    }
    case 'progress': {
      const clause = progressClause(report, item);
      if (clause !== null) return clause;
      break;
    }
    case 'blockers': {
      const blocker = findings.blockers.find((candidate) => candidate.stableId === item.stableId);
      if (blocker !== undefined) return interpretation.held(blocker.ageDays);
      break;
    }
    case 'risks': {
      const risk = findings.risks.find((candidate) => candidate.stableId === item.stableId);
      if (risk !== undefined) return interpretation.severity(risk.severity, risk.trend);
      break;
    }
    case 'recommendations': {
      const recommendation = findings.recommendations.find((candidate) => candidate.stableId === item.stableId);
      if (recommendation !== undefined) {
        return interpretation.step(recommendation.urgency === 'today' ? 'today' : 'this week');
      }
      break;
    }
    case 'wins': {
      const win = findings.wins.find((candidate) => candidate.stableId === item.stableId);
      const threshold = win?.thresholds[0];
      if (threshold !== undefined) return interpretation.threshold(threshold.id, true);
      break;
    }
  }

  // The terminal fallback is the change tag rather than the evidence count,
  // because the item's own evidence sentence already carries that clause and a
  // claim that said "traced to 2 artifacts" twice in two sentences would read
  // like a template rather than like prose.
  return interpretation.change(item.changeTag);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The lead sentence: the section's own summary, or its stated absence.
 *
 * With no summary the lead states no figure of its own — repeating the count and
 * then interpreting it as the count would be a sentence that says one thing
 * twice. The count still reaches the reader, through the clause.
 */
function leadSentence(section: ReportSection): string {
  const count = section.items.length;
  const clause = interpretation.sectionCount(count);

  if (count === 0) return statedSentence(section.emptyStatement, clause);
  if (section.summary !== undefined && section.summary.length > 0) {
    return groundedSentence(section.summary, clause);
  }
  return groundedSentence(`${section.title} carries what follows`, clause);
}

/**
 * The clause that interprets an item's run-in change sentence.
 *
 * The order is deliberate. A manager's own verdict outranks Compass's arithmetic — an accepted
 * step is their decision and a resurfaced risk is a direct answer to something they did, and
 * neither should be explained as "day 6 of it". Below that, an item that has been carried over
 * is interpreted by how long it has been carried, from `firstSeenAt`: that is the sentence which
 * stops the same finding reading as news on the sixth morning.
 */
function changeSentenceClause(report: StructuredReport, item: ReportItem): InterpretationClause {
  const feedback = item.feedback;
  if (feedback !== undefined) {
    return feedback.state === 'accepted'
      ? interpretation.accepted(new Date(feedback.at).toISOString().slice(0, 10))
      : interpretation.resurfaced(resurfacedDelta(item), MATERIAL_WORSENING_DELTA);
  }

  // The age of the item, counted from the first report that carried it — not the age of the
  // condition. "You have been reading this for six mornings" is the fact the reader is owed.
  const presenceDays = itemPresenceDays(item, report.instant);
  if (item.changeTag === 'unchanged' && presenceDays > 0) return interpretation.elapsed(presenceDays);
  if (item.ageDays > 0) return interpretation.elapsed(item.ageDays);
  return interpretation.change(item.changeTag);
}

/**
 * The severity movement a resurfacing clause states, read back out of the item's own sentence.
 *
 * The renderer is handed the clause `feedback.ts` wrote and must interpret the numbers already in
 * it; recomputing a delta from a baseline it does not hold would let the interpretation state a
 * different figure from the sentence beside it. Falling back to the threshold itself keeps the
 * clause true — a resurfacing happened, so the movement was at least that — rather than printing
 * a zero that the prose would then contradict.
 */
function resurfacedDelta(item: ReportItem): number {
  const stated = /(\d+) more, against the/.exec(item.feedback?.clause ?? '');
  return stated === null ? MATERIAL_WORSENING_DELTA : Number.parseInt(stated[1] ?? '', 10);
}

/** One item: the claim, what changed since yesterday, and the evidence. */
function itemSentences(report: StructuredReport, sectionKey: SectionKey, item: ReportItem): readonly string[] {
  const claimClause = clauseFor(report, sectionKey, item);
  const sentences = [groundedSentence(item.headline, claimClause)];

  const changeClause = item.changeClause;
  // A run-in clause the claim's own interpretation already contains adds nothing
  // — a recommendation's "today" is exactly what "finishable today" just said.
  const alreadySaid =
    changeClause !== undefined && claimClause.text.toLowerCase().includes(changeClause.trim().toLowerCase());

  if (!alreadySaid && changeClause !== undefined && changeClause.length > 0) {
    // The run-in clause is about persistence, so it is always paired with an interpretation of
    // *why it persists* rather than only when the clause happens to carry a number of its own.
    // Change since yesterday is stated as a clause, never as a badge saying NEW.
    sentences.push(groundedSentence(capitalize(flatten(changeClause)), changeSentenceClause(report, item)));
  }
  if (item.evidence.length > 0) {
    sentences.push(
      groundedSentence(
        `Evidence: ${item.evidence.map((reference) => reference.label).join(', ')}`,
        interpretation.evidence(item.evidence.length),
      ),
    );
  }

  return sentences.filter((sentence) => sentence.length > 0).slice(0, MAX_SENTENCES_PER_ITEM);
}

/**
 * One section's prose: a lead sentence, then one paragraph per item.
 *
 * Paragraphs are separated by a blank line so the same string reads correctly in
 * a terminal, an email body and a Server Component that splits on `\n\n`.
 */
export interface SectionParts {
  readonly lead: string;
  readonly claims: readonly RenderedClaim[];
  readonly trailer: string | null;
  /** The parts joined with a blank line — what the section reads as. */
  readonly prose: string;
}

export function renderSectionParts(report: StructuredReport, section: ReportSection): SectionParts {
  const lead = leadSentence(section);
  const claims: RenderedClaim[] = section.items.map((item) => ({
    stableId: item.stableId,
    prose: itemSentences(report, section.key, item).join(' '),
  }));

  // The confidence collar appears once per report, under Progress: the
  // calibration verdict in the product's own plain voice, carrying the same
  // clause the projected date does, so the two cannot be read apart.
  //
  // Two lines, matching the design's two-line collar. The first is the estimate
  // calibration; the second is the Process Calibration Audit's verdict on the data
  // as a whole. The audit line comes second on purpose — it is allowed to undercut
  // the date directly above it, and the reader should meet the number first and the
  // reason to doubt it immediately after.
  let trailer: string | null = null;
  if (section.key === 'progress') {
    const projection = report.findings.projection;
    const collar = statedSentence(
      projection.calibration.statement,
      projection.kind === 'projected'
        ? interpretation.collar(projection.band.confidence, projection.method)
        : interpretation.threshold(projection.threshold.id, false),
    );
    const audit = report.findings.calibrationAudit;
    const auditLine = statedSentence(audit.statement, interpretation.calibration(audit.verdictNames));
    const lines = [collar, auditLine].filter((line) => line.length > 0);
    if (lines.length > 0) trailer = lines.join(' ');
  }

  const prose = [lead, ...claims.map((claim) => claim.prose), ...(trailer === null ? [] : [trailer])]
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n');

  return { lead, claims, trailer, prose };
}

export function renderSectionProse(report: StructuredReport, section: ReportSection): string {
  return renderSectionParts(report, section).prose;
}

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------

/**
 * The change line: what moved since the previous report, or the plain statement that nothing
 * did.
 *
 * `statedSentence` on the quiet path and a grounded one when there are counts, which is not a
 * detail: "Nothing material changed since yesterday." carries no quantity, and appending a
 * clause explaining what its numbers mean would append an explanation of nothing. The counting
 * path always carries digits, so it always carries the clause.
 */
export function renderChangeLine(report: StructuredReport): string {
  const summary = report.changeSummary;
  const statement = summary.statement;
  if (statement.length === 0) return '';

  return extractNumericTokens(statement).length > 0
    ? groundedSentence(statement, interpretation.movement())
    : statedSentence(statement, interpretation.movement());
}

export function renderReport(report: StructuredReport): RenderedReport {
  assertSixSectionsInOrder(report);

  const masthead = renderMasthead(report);
  const freshness = renderFreshness(report);
  const changeLine = renderChangeLine(report);

  const sections: RenderedSection[] = report.sections.map((section, position) => {
    const definition = SECTIONS[position];
    if (definition === undefined) {
      throw new Error(`No section definition at position ${position}; the Six Spine is fixed at ${SECTIONS.length}.`);
    }
    const parts = renderSectionParts(report, section);
    return {
      key: section.key,
      index: definition.index,
      numeral: definition.numeral,
      title: section.title,
      prose: parts.prose,
      lead: parts.lead,
      claims: parts.claims,
      trailer: parts.trailer,
    };
  });

  const prose = [freshness, changeLine, ...sections.map((section) => section.prose)]
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n');
  assertEveryQuantityInterpreted(prose);
  /*
    No word-budget assertion here, and that is a decision rather than an omission.

    `DAILY_REPORT_WORD_BUDGET` is a ceiling asserted in the gate over the seeded dataset, not a throw
    on the render path. Throwing was tried and is wrong: the seeded daily renders about 1,750 words,
    so a hard limit here replaced a report that is longer than we would like with *no report at all*
    at 06:00 — strictly worse for the person waiting for it. The merged report throws because it
    exists only to be short; a daily that ran long is still the manager's report about their own team.
  */

  const text = [
    masthead,
    '',
    freshness,
    '',
    ...(changeLine.length === 0 ? [] : [changeLine, '']),
    ...sections.flatMap((section) => [`${section.numeral} ${section.title.toUpperCase()}`, '', section.prose, '']),
  ]
    .join('\n')
    .trimEnd();

  return { rendererId: RENDERER_ID, masthead, freshness, changeLine, sections, prose, text: `${text}\n` };
}
