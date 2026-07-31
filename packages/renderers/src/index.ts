/**
 * @compass/renderers — one structured report, three channels.
 *
 * Layer position: above analysis, below the pipeline. Every channel — web, email,
 * Slack — reads the same six sections in the same fixed order with no chart,
 * sparkline or gauge anywhere, and every sentence any of them shows was written
 * by the one deterministic renderer in `prose.ts`. That is also the fail-closed
 * fallback the narration path drops to, which is why it renders the whole report
 * rather than a placeholder.
 */
export {
  INTERPRETATION_TEMPLATES,
  INTERPRETATION_TEMPLATE_IDS,
  interpretation,
  interpretationClauseIn,
  interpretationTemplate,
  type InterpretationClause,
  type InterpretationTemplateDefinition,
  type InterpretationTemplateId,
  type PaceVerdict,
} from './interpretation-templates.js';

export {
  MAX_SENTENCES_PER_ITEM,
  RENDERER_ID,
  UngroundedNumberError,
  assertEveryQuantityInterpreted,
  renderFreshness,
  renderMasthead,
  renderReport,
  renderSectionParts,
  renderSectionProse,
  type RenderedClaim,
  type RenderedReport,
  type RenderedSection,
  type SectionParts,
} from './prose.js';

export { renderCoverageLine, renderPlainTextReport, type PlainTextOptions } from './plain-text.js';

export {
  PROSE_TOKEN_TYPES,
  collapseWhitespace,
  escapeHtml,
  parseProse,
  parseProseInlines,
  renderProseHtml,
  renderProseText,
  type ProseInline,
  type ProseInlineType,
  type ProseParagraph,
} from './markdown.js';
