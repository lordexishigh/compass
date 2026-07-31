import type { Instant, TimeWindow } from './instant.js';
import { SECTIONS, type SectionKey } from './sections.js';

/**
 * The structured report: the versioned contract every renderer reads, and the
 * only thing narration is ever shown.
 *
 * `schemaVersion` is stored on every persisted report row so a consumer can
 * always tell which shape it is holding.
 */
export const REPORT_SCHEMA_VERSION = 1;

export type ReportScope = { readonly kind: 'team'; readonly teamKey: string } | { readonly kind: 'merged' };

/** Where a claim's receipt lives. Every computed claim carries at least one. */
export interface EvidenceRef {
  readonly kind: 'commit' | 'pull_request' | 'issue' | 'branch' | 'release' | 'message' | 'memo';
  /** The identifier a human would recognise: `DEV-501`, `#883`, `1a2b3c4`. */
  readonly label: string;
  readonly sourceKey: string;
  readonly sourceRecordId: string;
}

export type ChangeTag = 'new' | 'unchanged' | 'worsened' | 'improved' | 'resolved';

export interface ReportItem {
  /**
   * Derived from the underlying entity and cause — never from the report or the
   * run — so the same condition on consecutive days is one item with a history.
   */
  readonly stableId: string;
  readonly headline: string;
  readonly detail: string;
  readonly changeTag: ChangeTag;
  /** Days this item has been continuously present, from its first sighting. */
  readonly ageDays: number;
  readonly evidence: readonly EvidenceRef[];
}

export interface ReportSection {
  readonly key: SectionKey;
  readonly index: number;
  readonly title: string;
  readonly items: readonly ReportItem[];
  /** Shown in place of the items when there are none. Never a blank space. */
  readonly emptyStatement: string;
}

/** What was and was not ingested, stated plainly under the masthead. */
export interface ReportCoverageNote {
  readonly sourceKey: string;
  readonly status: 'complete' | 'partial' | 'unavailable';
  readonly detail: string;
}

export interface StructuredReport {
  readonly schemaVersion: number;
  readonly organizationId: string;
  readonly scope: ReportScope;
  /** The instant the report was generated *for* — not when it was generated. */
  readonly instant: Instant;
  readonly timezone: string;
  readonly window: TimeWindow;
  readonly sections: readonly ReportSection[];
  readonly coverage: readonly ReportCoverageNote[];
}

export interface EmptyReportInput {
  readonly organizationId: string;
  readonly scope: ReportScope;
  readonly instant: Instant;
  readonly timezone: string;
  readonly window: TimeWindow;
  readonly coverage?: readonly ReportCoverageNote[];
}

/**
 * A well-formed report with all six sections and no items — the honest shape for
 * an organization with no signal yet. Pure: the instant is supplied, never read.
 */
export function createEmptyStructuredReport(input: EmptyReportInput): StructuredReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    organizationId: input.organizationId,
    scope: input.scope,
    instant: input.instant,
    timezone: input.timezone,
    window: input.window,
    sections: SECTIONS.map((section) => ({
      key: section.key,
      index: section.index,
      title: section.title,
      items: [],
      emptyStatement: section.emptyStatement,
    })),
    coverage: input.coverage ?? [],
  };
}

export class SectionOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SectionOrderError';
  }
}

/** Fails loudly if a report ever grows, loses or reorders a section. */
export function assertSixSectionsInOrder(report: StructuredReport): void {
  if (report.sections.length !== SECTIONS.length) {
    throw new SectionOrderError(
      `A report has exactly ${SECTIONS.length} sections; this one has ${report.sections.length}.`,
    );
  }
  SECTIONS.forEach((expected, position) => {
    const actual = report.sections[position];
    if (!actual || actual.key !== expected.key || actual.index !== expected.index) {
      throw new SectionOrderError(
        `Section ${position + 1} must be \`${expected.key}\`; found \`${actual?.key ?? 'nothing'}\`.`,
      );
    }
  });
}

export function sectionOf(report: StructuredReport, key: SectionKey): ReportSection {
  const section = report.sections.find((candidate) => candidate.key === key);
  if (!section) {
    throw new SectionOrderError(`This report has no \`${key}\` section.`);
  }
  return section;
}

/** Item counts per section, in fixed order — what the spine displays in mono. */
export function sectionCounts(report: StructuredReport): readonly { key: SectionKey; count: number }[] {
  return report.sections.map((section) => ({ key: section.key, count: section.items.length }));
}
