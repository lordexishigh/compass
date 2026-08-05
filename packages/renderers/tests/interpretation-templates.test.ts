import { extractNumericTokens } from '@compass/analysis';
import { describe, expect, it } from 'vitest';

import {
  INTERPRETATION_TEMPLATES,
  INTERPRETATION_TEMPLATE_IDS,
  interpretation,
  interpretationClauseIn,
  interpretationTemplate,
} from '@compass/renderers';

/**
 * The documented set, held to its own documentation.
 *
 * Each template carries an `example` written for a human to read. If the example
 * and the pattern ever disagree, the documentation is wrong and this fails —
 * which is the only arrangement in which prose documentation of a code rule does
 * not rot.
 */
describe('the interpretation-template set', () => {
  it('declares one template per documented id, and no orphans either way', () => {
    expect(INTERPRETATION_TEMPLATES.map((template) => template.id)).toEqual([...INTERPRETATION_TEMPLATE_IDS]);
  });

  it.each(INTERPRETATION_TEMPLATES.map((template) => [template.id, template] as const))(
    '%s: its documented example matches its own pattern',
    (_id, template) => {
      expect(template.pattern.test(template.example), `${template.example} !~ ${String(template.pattern)}`).toBe(true);
    },
  );

  it.each(INTERPRETATION_TEMPLATES.map((template) => [template.id, template] as const))(
    '%s: states what kind of number it is allowed to explain',
    (_id, template) => {
      expect(template.purpose.length).toBeGreaterThan(20);
    },
  );

  it('names the template a clause came from, and nothing for prose with none', () => {
    expect(interpretationClauseIn('Sprint 43 is 62% complete — which is behind the pace the elapsed schedule implies.')?.id).toBe(
      'pace',
    );
    expect(interpretationClauseIn('Four reviews are waiting nine days.')).toBeNull();
  });

  it('refuses an id it does not have, by name', () => {
    expect(() => interpretationTemplate('burndown' as never)).toThrow('burndown');
  });
});

/**
 * Every instantiation is checked against the pattern that recognises it, in every
 * branch. A template whose `render` drifts from its `pattern` would let the
 * renderer emit a clause the guard could not see.
 */
describe('every instantiation is recognised by its own template', () => {
  const clauses = [
    interpretation.pace('ahead of'),
    interpretation.pace('behind'),
    interpretation.pace('level with'),
    interpretation.rate(),
    interpretation.ladder('R0', null, true),
    interpretation.ladder('R2', 'merged', true),
    interpretation.ladder('R3', 'accepted', false),
    interpretation.ladder('R5', 'deployed', true),
    interpretation.threshold('T1', true),
    interpretation.threshold('T13', false),
    interpretation.held(0),
    interpretation.held(1),
    interpretation.held(6),
    interpretation.severity('high', 'worsened'),
    interpretation.severity('low', 'improving'),
    interpretation.step('today'),
    interpretation.step('this week'),
    interpretation.elapsed(1),
    interpretation.elapsed(14),
    interpretation.evidence(1),
    interpretation.evidence(3),
    interpretation.change('new'),
    interpretation.change('resolved'),
    interpretation.sectionCount(0),
    interpretation.sectionCount(1),
    interpretation.sectionCount(12),
    interpretation.coverage(4, 4),
    interpretation.coverage(3, 4),
    interpretation.coverage(0, 4),
    interpretation.coverage(0, 0),
    interpretation.collar('low', 'cycle_time'),
    interpretation.collar('high', 'trailing_velocity'),
    interpretation.aging(1),
    interpretation.aging(8),
  ];

  it.each(clauses.map((clause) => [clause.templateId, clause.text] as const))(
    '%s: "%s"',
    (templateId, text) => {
      expect(interpretationTemplate(templateId).pattern.test(text)).toBe(true);
      expect(interpretationClauseIn(text)?.id).toBe(templateId);
    },
  );

  it('reads the singular and the plural correctly, since a report shows both', () => {
    expect(interpretation.held(1).text).toContain('has held for 1 day and');
    expect(interpretation.held(2).text).toContain('has held for 2 days and');
    expect(interpretation.evidence(1).text).toContain('1 artifact you');
    expect(interpretation.sectionCount(1).text).toContain('1 item');
    expect(interpretation.sectionCount(2).text).toContain('2 items');
  });

  it('never writes a clause whose own numbers the extractor cannot see', () => {
    // A clause is only useful if the number it explains sits in the same sentence
    // as the clause; when the clause carries its own quantity, that quantity has
    // to be tokenisable too, or the guard would pass on a technicality.
    expect(extractNumericTokens(interpretation.sectionCount(4).text).map((token) => token.text)).toEqual(['4']);
    expect(extractNumericTokens(interpretation.coverage(3, 4).text).map((token) => token.text)).toEqual(['1', '4']);
  });
});
