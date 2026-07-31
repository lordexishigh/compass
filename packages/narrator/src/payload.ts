import {
  SECTIONS,
  assertSixSectionsInOrder,
  type ChangeTag,
  type ReportItem,
  type ReportSection,
  type SectionKey,
  type StructuredReport,
} from '@compass/analysis';
import { formatCivilDate, formatCivilDateTime } from '@compass/clock';

/**
 * The narration payload: the only thing the model is ever shown.
 *
 * This is the load-bearing file of the whole narration feature, and it is a
 * *projection* rather than a pass-through for one reason: the structured report
 * contains raw ingested text, and the model must not see it.
 *
 * Specifically, `ReportItemAlignment.evidence` carries `searchedText` — which is
 * the **verbatim commit message** the alignment tier matched a tracker key
 * inside — plus `comparedTextA`/`comparedTextB`, the two texts the semantic tier
 * scored. Handing the section object straight to the model would put commit
 * messages in the request, and the acceptance criterion for this task says it may
 * not. So every field the model receives is named here, explicitly, one at a
 * time, and `assertNoRawIngestedText` proves the list stayed honest.
 *
 * The projection is also what makes the grounding validator meaningful. Grounding
 * asks "is this token in the payload?", and the payload it asks about is *this*
 * object — the exact bytes that went into the request. Ground against the full
 * report instead and the validator would accept a number the model could not
 * possibly have known, which is the one thing it exists to catch.
 *
 * ## What does reach the model
 *
 * Headlines, details, evidence *labels* (`CHK-701`, `#883`, `7a8b9c0`), counts,
 * ages, ladder rungs and alignment verdicts — all of them written by the pure
 * analysis core, none of them free-form text from a source system. A ticket title
 * does travel inside a headline the core composed, which is why the prompt wraps
 * the payload in untrusted-data delimiters: a title is short, structured and
 * necessary, and it is still attacker-controlled.
 */

/** The five-notch meter, reduced to what a sentence can say about it. */
export interface NarrationLadder {
  readonly highestCrossed: string;
  readonly highestCrossedLabel: string | null;
  readonly deploySignalAvailable: boolean;
  /** `no deploy signal available`, when the top rung is unreachable. */
  readonly unreachableStatement: string | null;
}

/**
 * An alignment verdict, with its resolution path deliberately left behind.
 *
 * The confidence, the threshold and the objective title travel; the matched
 * substring, the searched text and the compared texts do not. The narrator's job
 * is to say the verdict in a sentence, and it can do that from a score and a
 * name — it has no use for the commit message the score came from, and that
 * message is the one field here that a person outside the org wrote.
 */
export interface NarrationAlignment {
  readonly kind: 'off_goal' | 'unattributed';
  readonly label: string | null;
  readonly resolvedTier: string;
  readonly confidence: number;
  readonly threshold: number;
  readonly thresholdId: string;
  /**
   * The goal-node id the verdict resolved against — `OBJ-Q2-BILL`.
   *
   * A computed identifier, not ingested text, and it travels because the narrator
   * has to be able to name the objective it is flagging work against. Grounding
   * treats it as its own token kind, so a narration cannot move an OFF-GOAL flag
   * from one dead objective to another.
   */
  readonly objectiveNodeId: string | null;
  readonly objectiveTitle: string | null;
  readonly question: string | null;
  readonly subjectLabels: readonly string[];
}

export interface NarrationItem {
  readonly stableId: string;
  readonly headline: string;
  readonly detail: string;
  readonly changeTag: ChangeTag;
  readonly ageDays: number;
  readonly changeClause: string | null;
  /** `CHK-701`, `#883`, `7a8b9c0` — labels only, never source record ids. */
  readonly evidenceLabels: readonly string[];
  readonly ladder: NarrationLadder | null;
  readonly alignment: NarrationAlignment | null;
}

export interface NarrationSection {
  readonly key: SectionKey;
  readonly index: number;
  /** `01`–`06`. */
  readonly numeral: string;
  readonly title: string;
  readonly summary: string | null;
  readonly emptyStatement: string;
  readonly itemCount: number;
  readonly items: readonly NarrationItem[];
}

/** The masthead facts, so the narrator can name the day without inventing one. */
export interface NarrationContext {
  readonly reportDate: string;
  readonly scopeLabel: string;
  readonly timezone: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly coverage: readonly { readonly sourceKey: string; readonly status: string }[];
}

export interface NarrationPayload {
  readonly context: NarrationContext;
  readonly sections: readonly NarrationSection[];
}

/** One section plus the context it is read against — what one request carries. */
export interface NarrationSectionRequest {
  readonly context: NarrationContext;
  readonly section: NarrationSection;
}

const scopeLabelOf = (report: StructuredReport): string =>
  report.scope.kind === 'team' ? report.scope.teamKey : 'all teams';

function ladderOf(item: ReportItem): NarrationLadder | null {
  const ladder = item.ladder;
  if (ladder === undefined) return null;

  const unreachable = ladder.notches.find((notch) => !notch.reachable && notch.statement !== null);
  return {
    highestCrossed: ladder.highestCrossed,
    highestCrossedLabel: ladder.highestCrossedLabel,
    deploySignalAvailable: ladder.deploySignalAvailable,
    unreachableStatement: unreachable?.statement ?? null,
  };
}

function alignmentOf(item: ReportItem): NarrationAlignment | null {
  const alignment = item.alignment;
  if (alignment === undefined) return null;

  return {
    kind: alignment.kind,
    label: alignment.label,
    resolvedTier: alignment.resolvedTier,
    confidence: alignment.confidence,
    threshold: alignment.threshold,
    thresholdId: alignment.thresholdId,
    objectiveNodeId: alignment.objectiveNodeId,
    objectiveTitle: alignment.objectiveTitle,
    question: alignment.question,
    subjectLabels: [...alignment.subjectLabels],
  };
}

function itemOf(item: ReportItem): NarrationItem {
  return {
    stableId: item.stableId,
    headline: item.headline,
    detail: item.detail,
    changeTag: item.changeTag,
    ageDays: item.ageDays,
    changeClause: item.changeClause ?? null,
    evidenceLabels: item.evidence.map((reference) => reference.label),
    ladder: ladderOf(item),
    alignment: alignmentOf(item),
  };
}

function sectionOf(section: ReportSection, index: number, numeral: string): NarrationSection {
  return {
    key: section.key,
    index,
    numeral,
    title: section.title,
    summary: section.summary ?? null,
    emptyStatement: section.emptyStatement,
    itemCount: section.items.length,
    items: section.items.map(itemOf),
  };
}

/**
 * The whole payload, six sections in the fixed order.
 *
 * The order comes from `SECTIONS`, like every other consumer's does, so a narrated
 * report and a template-rendered one cannot disagree about what section three is.
 */
export function narrationPayload(report: StructuredReport): NarrationPayload {
  assertSixSectionsInOrder(report);

  return {
    context: {
      reportDate: formatCivilDate(report.instant, report.timezone),
      scopeLabel: scopeLabelOf(report),
      timezone: report.timezone,
      windowStart: formatCivilDateTime(report.window.start, report.timezone),
      windowEnd: formatCivilDateTime(report.window.end, report.timezone),
      coverage: report.coverage.map((note) => ({ sourceKey: note.sourceKey, status: note.status })),
    },
    sections: report.sections.map((section, position) => {
      const definition = SECTIONS[position];
      if (definition === undefined) {
        throw new Error(`No section definition at position ${position}; the Six Spine is fixed at ${SECTIONS.length}.`);
      }
      return sectionOf(section, definition.index, definition.numeral);
    }),
  };
}

/** The six per-section requests, in order — one model call each. */
export function sectionRequests(payload: NarrationPayload): readonly NarrationSectionRequest[] {
  return payload.sections.map((section) => ({ context: payload.context, section }));
}

export class RawIngestedTextError extends Error {
  readonly field: string;

  constructor(field: string, path: string) {
    super(
      `The narration payload carries \`${path}\`, which is a raw-ingested-text field (\`${field}\`). ` +
        'The narrator is shown computed claims only: a commit message, a pull request body, a tracker comment or a ' +
        'chat message must never reach the model. Project the field away in `payload.ts` rather than widening this check.',
    );
    this.name = 'RawIngestedTextError';
    this.field = field;
  }
}

/**
 * Field names that only ever hold verbatim text from a source system.
 *
 * This is a *structural* check rather than a content scan, and that is the point.
 * Scanning for "does this string look like a commit message" is unfalsifiable —
 * a one-word commit message looks like a label. Scanning for the field that
 * carries commit messages is exact: `searchedText` exists in precisely one place
 * in the analysis output and it exists to hold the text a tracker key was found
 * inside.
 *
 * `message` and `rawText` are here for the fields that do not exist in the report
 * payload yet but will the moment Manager Memos land, so the gate is already
 * closed when they do.
 */
export const RAW_INGESTED_TEXT_FIELDS: readonly string[] = Object.freeze([
  'searchedText',
  'matchedSubstring',
  'comparedTextA',
  'comparedTextB',
  'message',
  'commitMessage',
  'body',
  'rawText',
  'comment',
  'evidence',
]);

/**
 * Walks any value and throws if a raw-text field name appears anywhere in it.
 *
 * Run over the payload *and* over the serialised prompt, because the two can
 * diverge: a prompt builder that stringified the original report rather than the
 * projection would pass a payload check and still ship a commit message.
 */
export function assertNoRawIngestedText(value: unknown, path = 'payload'): void {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawIngestedText(entry, `${path}[${index}]`));
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (RAW_INGESTED_TEXT_FIELDS.includes(key)) {
      throw new RawIngestedTextError(key, `${path}.${key}`);
    }
    assertNoRawIngestedText(nested, `${path}.${key}`);
  }
}
