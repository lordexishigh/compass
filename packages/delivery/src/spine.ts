import { SECTION_ORDER, type SectionKey } from '@compass/analysis';
import type { RenderedReport, RenderedSection } from '@compass/renderers';

/**
 * The Six Spine, for a channel that is not the web page.
 *
 * Email and Slack both have to show the same six sections in the same order as `/`, and the
 * order already has exactly one definition — `SECTION_ORDER` in `@compass/analysis`. Neither
 * channel gets to hold its own list: a second copy is how the Slack message ends up with
 * Wins before Risks after somebody edits one file.
 *
 * This module is the guard rather than the list. It reads the shared constant, checks that the
 * report it was handed actually carries those six in that order, and refuses if not — because
 * a channel that quietly dropped a section would produce a plausible-looking email that was
 * missing the manager's blockers, which is worse than an error.
 */

export class DeliverySpineError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'DeliverySpineError';
    this.detail = detail;
  }
}

/**
 * The six sections, in the fixed order, or an error naming what was wrong.
 *
 * Both channels call this before writing a single byte. A report with five sections, seven, or
 * the right six in the wrong order is a bug upstream, and the delivery layer is the last place
 * that can notice before a manager reads the result.
 */
export function orderedSections(report: RenderedReport): readonly RenderedSection[] {
  const found = report.sections.map((section) => section.key);

  if (found.length !== SECTION_ORDER.length) {
    throw new DeliverySpineError(
      `A report to deliver must carry exactly ${SECTION_ORDER.length} sections; this one has ${found.length} ` +
        `(${found.join(', ') || 'none'}). The Six Spine never grows or loses a section.`,
    );
  }

  for (const [position, expected] of SECTION_ORDER.entries()) {
    if (found[position] !== expected) {
      throw new DeliverySpineError(
        `Section ${position + 1} must be \`${expected}\` and is \`${found[position]}\`. Every channel shows the six ` +
          'in the same order in every report forever, so a manager can read it like a familiar newspaper.',
      );
    }
  }

  return report.sections;
}

/** The section keys, for a test that wants to assert against the shared order. */
export const DELIVERED_SECTION_KEYS: readonly SectionKey[] = SECTION_ORDER;
