/**
 * @compass/renderers — one structured report, three channels.
 *
 * Layer position: above analysis, below the pipeline. The web, email and Slack
 * renderers all emit exactly six sections in the fixed order with no chart,
 * sparkline or gauge; this package holds the deterministic text renderer that
 * the others and the fail-closed narration path share.
 */
export { renderCoverageLine, renderPlainTextReport, type PlainTextOptions } from './plain-text.js';
