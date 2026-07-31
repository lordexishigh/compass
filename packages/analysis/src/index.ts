/**
 * @compass/analysis — the pure deterministic core.
 *
 * No HTTP, no database, no filesystem, no clock, no randomness, and no
 * dependencies at all: `package.json` declares none, dependency-cruiser forbids
 * every import edge, and ESLint bans `Math.random` and `process` here. Every
 * exported function takes the instant it should reason about as a parameter.
 */
export { compareInstants, compareStable, windowContains, type Instant, type TimeWindow } from './instant.js';

export { SECTIONS, SECTION_ORDER, sectionDefinition, type SectionDefinition, type SectionKey } from './sections.js';

export {
  REPORT_SCHEMA_VERSION,
  SectionOrderError,
  assertSixSectionsInOrder,
  createEmptyStructuredReport,
  sectionCounts,
  sectionOf,
  type ChangeTag,
  type EmptyReportInput,
  type EvidenceRef,
  type ReportCoverageNote,
  type ReportItem,
  type ReportScope,
  type ReportSection,
  type StructuredReport,
} from './structured-report.js';
