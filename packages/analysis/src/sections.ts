/**
 * The Six Spine.
 *
 * Six sections, this order, in every report forever — that is what lets a
 * manager learn the geography of the page in two days. The order is a constant,
 * not a configuration value, and the renderers and the web spine all read it
 * from here so there is exactly one definition.
 */
export const SECTION_ORDER = [
  'yesterday',
  'progress',
  'blockers',
  'risks',
  'recommendations',
  'wins',
] as const;

export type SectionKey = (typeof SECTION_ORDER)[number];

export interface SectionDefinition {
  readonly key: SectionKey;
  /** 1–6. Rendered as the fixed `01`–`06` numeral in front of the heading. */
  readonly index: number;
  readonly numeral: string;
  readonly title: string;
  /**
   * What the section says when it has nothing to say. Absence of signal is
   * stated as a fact in the product's own voice — never a blank panel.
   */
  readonly emptyStatement: string;
}

export const SECTIONS: readonly SectionDefinition[] = Object.freeze(
  (
    [
      ['yesterday', 'Yesterday', 'Nothing crossed a completion threshold yesterday.'],
      ['progress', 'Progress', 'No sprint or flow progress could be computed for this window.'],
      ['blockers', 'Blockers', 'Nothing is blocked on a signal Compass can see.'],
      ['risks', 'Risks', 'No risk crossed its threshold in this window.'],
      ['recommendations', 'Recommendations', 'Nothing needs your hand today.'],
      ['wins', 'Wins', 'No win met the documented threshold in this window.'],
    ] as const
  ).map(([key, title, emptyStatement], position) =>
    Object.freeze({
      key,
      index: position + 1,
      numeral: String(position + 1).padStart(2, '0'),
      title,
      emptyStatement,
    }),
  ),
);

export function sectionDefinition(key: SectionKey): SectionDefinition {
  const found = SECTIONS.find((section) => section.key === key);
  if (!found) {
    throw new Error(`Unknown report section \`${key}\`.`);
  }
  return found;
}
