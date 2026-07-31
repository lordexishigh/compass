import { SECTIONS } from '@compass/analysis';
import { formatCivilDateTime, type TimeWindow } from '@compass/clock';
import type { FreshnessReport, SourceFreshness, StoredReportBundle } from '@compass/db';
import { artifactHref } from '@compass/pipeline';

/**
 * The read model the report page renders.
 *
 * Everything here is derived from two values a request already has — the stored
 * bundle and the freshness report — and nothing here reads a clock, opens a
 * connection or formats a date from the host zone. That is what lets the whole
 * view be rendered in a test from a fixture, which is the only way the "no chart,
 * six headings, every claim linked" assertions can be more than a promise.
 *
 * The one rule worth stating: **a value that is not known is null, and null
 * renders as a sentence.** There is no fallback to `now`, no "just now", no
 * em-dash standing in for a missing ingest time. A fabricated freshness value is
 * worse than an absent one, because a manager acts on it.
 */

export interface EvidenceLinkView {
  /** `¹`, `²`, … — the superscript marker printed beside the claim. */
  readonly marker: string;
  /** The identifier a human recognises: `DEV-501`, `#883`, `7a8b9c0`. */
  readonly label: string;
  readonly kind: string;
  /** In-app, always. Resolves to the artifact detail page. */
  readonly href: string;
  /** Read out to assistive technology in place of the bare superscript. */
  readonly description: string;
}

export interface LadderNotchView {
  readonly rung: string;
  readonly label: string;
  readonly crossed: boolean;
  readonly reachable: boolean;
  readonly statement: string | null;
}

export interface LadderView {
  readonly notches: readonly LadderNotchView[];
  readonly highestCrossed: string;
  readonly highestCrossedLabel: string | null;
  readonly deploySignalAvailable: boolean;
}

/**
 * A matched string, split so the matching span can be underlined in place.
 *
 * Split here rather than in the component, and by offset rather than by
 * `indexOf`: the analysis core recorded *where* it found the key, and a component
 * that searched for the substring again would highlight the first occurrence
 * instead of the one Compass actually used. In `feature/PLAT-1-and-PLAT-1-again`
 * those are different spans.
 */
export interface AlignmentHighlightView {
  readonly before: string;
  readonly match: string;
  readonly after: string;
  /** What was searched: "the branch name", "the commit message". */
  readonly caption: string;
}

/** The two texts a semantic match compared, and the wording they share. */
export interface AlignmentComparisonView {
  readonly subjectText: string;
  readonly goalText: string;
  readonly sharedTokens: readonly string[];
}

export interface AlignmentChainNodeView {
  readonly nodeId: string;
  readonly title: string | null;
}

/**
 * Everything the one-click evidence panel prints for one alignment verdict.
 *
 * Derived entirely from the stored item payload, so the panel shows what was
 * computed rather than a re-derivation: a manager arguing with a flag six weeks
 * later sees the chain, string or score that produced it, not today's answer to the
 * same question.
 */
export interface AlignmentView {
  readonly kind: 'off_goal' | 'unattributed';
  /** `OFF-GOAL`, or null — an unattributed item carries no label by design. */
  readonly label: string | null;
  readonly tier: string;
  /** "a configured chain", "an inferred tracker key", "a semantic match". */
  readonly tierLabel: string;
  readonly confidenceLabel: string;
  /**
   * The threshold, formatted — or null when the payload carried none.
   *
   * Null rather than `0.00`: a fabricated number here would be printed as the
   * value the confidence was compared against, which is the one thing on this
   * panel a manager is entitled to take literally.
   */
  readonly thresholdLabel: string | null;
  readonly thresholdId: string;
  /** False whenever the threshold is unknown — an unknown bar is not cleared. */
  readonly clearsThreshold: boolean;
  readonly objectiveNodeId: string | null;
  readonly objectiveTitle: string | null;
  /** The question an unattributed item asks, verbatim. */
  readonly question: string | null;
  readonly chain: readonly AlignmentChainNodeView[];
  readonly highlight: AlignmentHighlightView | null;
  readonly comparison: AlignmentComparisonView | null;
  readonly subjectLabels: readonly string[];
  /** The affordance's own line, before it is opened. */
  readonly summary: string;
  /** Unique per claim, so the disclosure has a stable accessible name. */
  readonly panelId: string;
}

export interface ClaimView {
  readonly stableId: string;
  readonly headline: string;
  readonly detail: string;
  /**
   * The renderer's own sentences for this claim.
   *
   * The page shows this rather than `headline`, because the renderer's rule —
   * no quantity without a clause interpreting it — lives in these sentences. A
   * view that printed the headline would print `62% complete` with the pace
   * clause stripped off.
   */
  readonly prose: string;
  readonly ageDays: number;
  readonly changeClause: string | null;
  readonly changeTag: string;
  readonly ladder: LadderView | null;
  readonly evidence: readonly EvidenceLinkView[];
  /** Present on alignment claims only. Null everywhere else. */
  readonly alignment: AlignmentView | null;
}

export interface SectionView {
  readonly key: string;
  readonly numeral: string;
  readonly ordinal: number;
  readonly title: string;
  readonly prose: string;
  readonly summary: string | null;
  readonly emptyStatement: string;
  readonly items: readonly ClaimView[];
}

export interface SourceFreshnessView {
  readonly sourceKey: string;
  readonly sourceKind: string;
  readonly status: string;
  readonly detail: string;
  /** Null when this source never answered. Never substituted. */
  readonly lastIngestLabel: string | null;
  /** The window the run asked this source for. */
  readonly windowLabel: string;
  /** The part of it the source actually covered. Null when it covered none. */
  readonly coveredLabel: string | null;
  readonly recordCount: number;
  readonly answered: boolean;
}

export interface FreshnessView {
  readonly hasIngestRecord: boolean;
  /** False whenever any configured source did not answer. */
  readonly complete: boolean;
  /** One sentence saying whether this report is a complete picture. */
  readonly statement: string;
  readonly lastIngestLabel: string | null;
  readonly runWindowLabel: string | null;
  readonly sources: readonly SourceFreshnessView[];
  readonly missingSourceKeys: readonly string[];
}

export interface ReportView {
  readonly reportId: string;
  readonly reportDate: string;
  readonly scopeLabel: string;
  readonly timezone: string;
  readonly windowLabel: string;
  readonly generatedAtLabel: string;
  readonly rendererId: string;
  readonly coverageStatus: string;
  readonly sections: readonly SectionView[];
  readonly freshness: FreshnessView;
  /** Set when the page is showing a day other than the host's own today. */
  readonly timeShiftNote: string | null;
}

const SUPERSCRIPTS = ['¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'] as const;

/** `¹`…`⁹`, then `¹⁰`-style pairs. Never a bracketed number in the prose. */
export function superscriptMarker(position: number): string {
  if (position <= SUPERSCRIPTS.length) return SUPERSCRIPTS[position - 1] ?? String(position);
  return String(position)
    .split('')
    .map((digit) => SUPERSCRIPTS[Number(digit) - 1] ?? '⁰')
    .join('');
}

/** What a marker says when it is read aloud rather than looked at. */
export function describeArtifact(kind: string, label: string): string {
  switch (kind) {
    case 'commit':
      return `commit ${label}`;
    case 'pull_request':
      return `pull request ${label}`;
    case 'issue':
      return `tracker item ${label}`;
    case 'release':
      return `release ${label}`;
    case 'sprint':
      return `sprint ${label}`;
    case 'branch':
      return `branch ${label}`;
    case 'message':
      return `message ${label}`;
    default:
      return `${kind} ${label}`;
  }
}

const windowLabel = (window: TimeWindow, timezone: string): string =>
  `${formatCivilDateTime(window.start, timezone)} → ${formatCivilDateTime(window.end, timezone)}`;

function ladderView(raw: Record<string, unknown> | null): LadderView | null {
  if (raw === null) return null;
  const notches = Array.isArray(raw['notches']) ? (raw['notches'] as readonly Record<string, unknown>[]) : [];

  return {
    notches: notches.map((notch) => ({
      rung: String(notch['rung'] ?? ''),
      label: String(notch['label'] ?? ''),
      crossed: notch['crossed'] === true,
      reachable: notch['reachable'] !== false,
      statement: typeof notch['statement'] === 'string' ? notch['statement'] : null,
    })),
    highestCrossed: String(raw['highestCrossed'] ?? 'R0'),
    highestCrossedLabel: typeof raw['highestCrossedLabel'] === 'string' ? raw['highestCrossedLabel'] : null,
    deploySignalAvailable: raw['deploySignalAvailable'] === true,
  };
}

// ---------------------------------------------------------------------------
// The alignment evidence panel
// ---------------------------------------------------------------------------

const TIER_LABELS: Readonly<Record<string, string>> = {
  configured: 'a configured chain',
  inferred: 'an inferred tracker key',
  semantic: 'a semantic match',
  unattributed: 'nothing Compass could tie it to',
};

const MATCHED_IN_CAPTIONS: Readonly<Record<string, string>> = {
  commit_message: 'the commit message',
  branch_name: 'the branch name',
};

const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asStringList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * The evidence panel's view, from the stored item payload.
 *
 * Read defensively, exactly like `ladderView`, and for the same reason: the payload
 * is JSON that a report written by an earlier build may not have carried at all. A
 * claim from before this feature existed has no `alignment` key, and the honest
 * answer there is `null` — no panel — rather than a panel full of empty rows.
 */
function alignmentView(raw: unknown, stableId: string): AlignmentView | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const kind = record['kind'] === 'off_goal' ? 'off_goal' : record['kind'] === 'unattributed' ? 'unattributed' : null;
  if (kind === null) return null;

  const tier = asText(record['resolvedTier']) ?? 'unattributed';
  const confidence = asNumber(record['confidence']) ?? 0;
  const threshold = asNumber(record['threshold']);
  const evidence = record['evidence'];
  const evidenceRecord =
    evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : {};

  const chainIds = asStringList(evidenceRecord['chainNodeIds']);
  const chainTitles = asStringList(evidenceRecord['chainTitles']);
  const objectiveNodeId = asText(record['objectiveNodeId']);
  const confidenceLabel = confidence.toFixed(2);
  // Not `?? 0`: a payload with no threshold is a payload that cannot say what the
  // confidence was compared against, and `0.00` would be read as that comparison.
  const thresholdLabel = threshold === null ? null : threshold.toFixed(2);

  return {
    kind,
    label: asText(record['label']),
    tier,
    tierLabel: TIER_LABELS[tier] ?? tier,
    confidenceLabel,
    thresholdLabel,
    thresholdId: asText(record['thresholdId']) ?? 'T17',
    // Presence, not magnitude: a threshold configured at 0 is a real threshold,
    // and an accepted verdict must not be printed as sitting below it.
    clearsThreshold: threshold !== null && confidence >= threshold,
    objectiveNodeId,
    objectiveTitle: asText(record['objectiveTitle']),
    question: asText(record['question']),
    chain: chainIds.map((nodeId, index) => ({ nodeId, title: chainTitles[index] ?? null })),
    highlight: highlightView(evidenceRecord),
    comparison: comparisonView(evidenceRecord),
    subjectLabels: asStringList(record['subjectLabels']),
    summary:
      kind === 'off_goal'
        ? `Resolved through ${TIER_LABELS[tier] ?? tier} — ${confidenceLabel}${
            thresholdLabel === null
              ? ', against a threshold this report did not record'
              : ` against a threshold of ${thresholdLabel}`
          }`
        : `Nothing cleared the threshold — the closest match scored ${confidenceLabel}${
            thresholdLabel === null ? '' : ` against ${thresholdLabel}`
          }`,
    panelId: `alignment-evidence-${stableId.replace(/[^a-zA-Z0-9]+/g, '-')}`,
  };
}

/** The searched string, split at the offset Compass recorded. */
function highlightView(evidence: Record<string, unknown>): AlignmentHighlightView | null {
  const searchedText = asText(evidence['searchedText']);
  const match = asText(evidence['matchedSubstring']);
  const offset = asNumber(evidence['matchedOffset']);
  const matchedIn = asText(evidence['matchedIn']);
  if (searchedText === null || match === null || offset === null || offset < 0) return null;

  // If the offset does not land on the recorded substring the payload disagrees
  // with itself, and a highlight in the wrong place is worse than none: it would
  // point a manager at a string Compass never matched.
  if (searchedText.slice(offset, offset + match.length) !== match) return null;

  return {
    before: searchedText.slice(0, offset),
    match,
    after: searchedText.slice(offset + match.length),
    caption: MATCHED_IN_CAPTIONS[matchedIn ?? ''] ?? 'the text Compass searched',
  };
}

function comparisonView(evidence: Record<string, unknown>): AlignmentComparisonView | null {
  const subjectText = asText(evidence['comparedTextA']);
  const goalText = asText(evidence['comparedTextB']);
  if (subjectText === null || goalText === null) return null;

  return { subjectText, goalText, sharedTokens: asStringList(evidence['matchedTokens']) };
}

/**
 * The per-source freshness rows, from `IngestRun` and nothing else.
 *
 * A source with no coverage row does not appear, and a source whose row says it
 * answered nothing is marked as not having answered — `recordCount === 0` is a
 * silence, not a quiet day, and the two must not render the same way.
 */
function sourceView(source: SourceFreshness, timezone: string): SourceFreshnessView {
  const answered = source.status === 'complete' && source.recordCount > 0;
  return {
    sourceKey: source.sourceKey,
    sourceKind: source.sourceKind,
    status: source.status,
    detail: source.detail,
    lastIngestLabel: source.lastObservedAt === null ? null : formatCivilDateTime(source.lastObservedAt, timezone),
    windowLabel: windowLabel(source.requestedWindow, timezone),
    coveredLabel: source.coveredWindow === null ? null : windowLabel(source.coveredWindow, timezone),
    recordCount: source.recordCount,
    answered,
  };
}

export function freshnessView(freshness: FreshnessReport, timezone: string): FreshnessView {
  if (!freshness.hasIngestRecord) {
    return {
      hasIngestRecord: false,
      complete: false,
      statement:
        'Compass has no record of an ingest for this window, so it cannot tell you how fresh this report is. It will not guess.',
      lastIngestLabel: null,
      runWindowLabel: null,
      sources: [],
      missingSourceKeys: [],
    };
  }

  const sources = freshness.sources.map((source) => sourceView(source, timezone));
  const missing = sources.filter((source) => !source.answered);
  const complete = sources.length > 0 && missing.length === 0;

  return {
    hasIngestRecord: true,
    complete,
    statement: complete
      ? `Every configured source answered for this window, so this report is a complete picture of ${sources.length} sources.`
      : missing.length === sources.length
        ? 'No configured source answered for this window, so this report is not a complete picture.'
        : `${missing.length} of ${sources.length} configured sources did not answer, so this report is not complete: ${missing
            .map((source) => source.sourceKey)
            .join(', ')}.`,
    lastIngestLabel:
      freshness.completedAt === null ? null : formatCivilDateTime(freshness.completedAt, timezone),
    runWindowLabel: freshness.window === null ? null : windowLabel(freshness.window, timezone),
    sources,
    missingSourceKeys: missing.map((source) => source.sourceKey),
  };
}

export interface BuildReportViewInput {
  readonly bundle: StoredReportBundle;
  readonly freshness: FreshnessReport;
  /** Stated when the page is showing a day other than the host's own today. */
  readonly timeShiftNote?: string | null;
}

export function buildReportView(input: BuildReportViewInput): ReportView {
  const { report, sections } = input.bundle;
  const timezone = report.timezone;
  const numerals = new Map<string, string>(SECTIONS.map((section) => [section.key, section.numeral]));

  return {
    reportId: report.id,
    reportDate: report.reportDate,
    scopeLabel: report.scopeKind === 'team' ? report.scopeKey : 'all teams',
    timezone,
    windowLabel: windowLabel(report.window, timezone),
    generatedAtLabel: formatCivilDateTime(report.generatedAt, timezone),
    rendererId: report.rendererId,
    coverageStatus: report.coverageStatus,
    sections: sections.map((section) => ({
      key: section.sectionKey,
      // The numeral comes from the Six Spine definition, never from the row's
      // position: a page that renumbered itself from whatever came back would
      // hide exactly the bug the fixed order exists to prevent.
      numeral: numerals.get(section.sectionKey) ?? String(section.ordinal).padStart(2, '0'),
      ordinal: section.ordinal,
      title: section.title,
      prose: section.prose,
      summary: section.summary,
      emptyStatement: section.emptyStatement,
      items: section.items.map((item) => ({
        stableId: item.stableId,
        headline: item.headline,
        detail: item.detail,
        prose: item.prose,
        ageDays: item.ageDays,
        changeClause: item.changeClause,
        changeTag: item.changeTag,
        ladder: ladderView(item.ladder),
        // The resolution path rides on the item payload, so both renderers read the
        // same field and neither can ship a verdict with no way to check it.
        alignment: alignmentView(item.payload['alignment'], item.stableId),
        evidence: item.evidence.map((reference, index) => ({
          marker: superscriptMarker(index + 1),
          label: reference.label,
          kind: reference.kind,
          href: artifactHref(reference.artifactKind, reference.artifactId),
          description: describeArtifact(reference.kind, reference.label),
        })),
      })),
    })),
    freshness: freshnessView(input.freshness, timezone),
    timeShiftNote: input.timeShiftNote ?? null,
  };
}
