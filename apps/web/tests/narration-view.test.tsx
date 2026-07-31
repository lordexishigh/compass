import { SECTIONS } from '@compass/analysis';
import {
  ALIGNMENT_AFFORDANCE_ATTRIBUTE,
  ALIGNMENT_VERDICT_ATTRIBUTE,
  FALLBACK_NOTE_ATTRIBUTE as SMOKE_FALLBACK_ATTRIBUTE,
  inspectReportHtml,
} from '@compass/smoke';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FALLBACK_NOTE_ATTRIBUTE, ReportDocument } from '../components/report-document';
import { buildReportView } from '../lib/view-model';

import {
  INJECTION_TITLE,
  fallbackBundle,
  freshnessWithMissingSource,
  injectionBundle,
  narratedBundle,
  storedBundle,
} from './helpers/report-fixture';

/**
 * The two things the page has to say about narration, and the one thing it must
 * never do with ingested text.
 *
 * Rendered through the real component tree with `renderToStaticMarkup`, because
 * every claim here is a claim about bytes: whether a `<script` appears, whether the
 * fallback disclosure is present, whether a narrated report still carries an
 * evidence link for every claim.
 */

const render = (bundle: ReturnType<typeof storedBundle>): string =>
  renderToStaticMarkup(
    <ReportDocument view={buildReportView({ bundle, freshness: freshnessWithMissingSource() })} />,
  );

describe('the page and the cold-start inspector agree on the marker', () => {
  it('uses the same attribute name in both', () => {
    // Two render paths exist — this component and anything else reading the stored
    // payload — and the inspector is what checks the container's live HTML. A name
    // that drifted would make the smoke test pass while asserting nothing.
    expect(FALLBACK_NOTE_ATTRIBUTE).toBe(SMOKE_FALLBACK_ATTRIBUTE);
  });

  it('makes the inspector see a disclosed fallback, and not see an absent one', () => {
    expect(inspectReportHtml(render(fallbackBundle())).narrationFallbackDisclosed).toBe(true);
    expect(inspectReportHtml(render(storedBundle())).narrationFallbackDisclosed).toBe(false);
  });
});

describe('a templated report says so and discloses nothing', () => {
  const markup = render(storedBundle());

  it('names the deterministic renderer in the footer', () => {
    expect(markup).toContain('Written by the deterministic template renderer');
    expect(markup).toContain('template');
  });

  it('shows no fallback disclosure, because nothing was attempted', () => {
    // A deployment with no Anthropic key is templated by design. Telling that reader
    // something failed would be a fabrication of its own.
    expect(markup).not.toContain(FALLBACK_NOTE_ATTRIBUTE);
    expect(markup).not.toContain('narration unavailable');
  });
});

describe('a narrated report renders the narration and keeps every receipt', () => {
  const markup = render(narratedBundle());

  it('names the narration model in the footer, and says the prose was checked', () => {
    expect(markup).toContain('Written by the narration model');
    expect(markup).toContain('checked against the');
    expect(markup).toContain('narrated');
  });

  it('shows no fallback disclosure', () => {
    expect(markup).not.toContain(FALLBACK_NOTE_ATTRIBUTE);
  });

  it('renders the narrated prose for every section', () => {
    for (const section of SECTIONS) {
      // `narratedBundle` writes "<title> has N thing worth your attention" per
      // section, so each section's own prose has to appear.
      expect(markup, `\`${section.key}\` did not render its narration`).toContain(
        `has 1 thing worth your attention this morning`,
      );
    }
  });

  it('renders the allowlisted markdown as elements, not as literal markers', () => {
    expect(markup).toContain('<strong');
    expect(markup).toContain('<em');
    expect(markup).toContain('<code');
    // The markers themselves are consumed.
    expect(markup).not.toContain('**Yesterday**');
    expect(markup).not.toContain('*age unchanged*');
  });

  it('still passes the cold-start inspection, so narration did not cost the links', () => {
    const inspection = inspectReportHtml(markup);
    expect(inspection.problems).toEqual([]);
    expect(inspection.sourceLinks.length).toBeGreaterThan(0);
  });

  it('keeps one evidence affordance per alignment verdict', () => {
    // Narration reorders items, so per-claim prose is gone — but the resolution path
    // is not, and a flag a manager cannot check is the one output this product must
    // never produce.
    const verdicts = markup.split(ALIGNMENT_VERDICT_ATTRIBUTE).length - 1;
    const affordances = markup.split(ALIGNMENT_AFFORDANCE_ATTRIBUTE).length - 1;

    expect(verdicts).toBeGreaterThan(0);
    expect(affordances).toBe(verdicts);
  });

  it('keeps the unattributed question visible, because a question must read as one', () => {
    expect(markup).toContain('What were these 2 commits for?');
  });

  it('keeps the completion ladder and the day sigil', () => {
    expect(markup).toContain('no deploy signal available');
    expect(markup).toContain('day 1');
  });

  it('does not repeat the templated per-claim sentences beneath the narration', () => {
    // Printing both would state every fact twice, in two different voices.
    expect(markup).not.toContain('so it reached R3 accepted and nothing above that');
  });
});

describe('a fallback report discloses itself', () => {
  const markup = render(fallbackBundle());

  it('carries the disclosure marker exactly once', () => {
    expect(markup.split(FALLBACK_NOTE_ATTRIBUTE)).toHaveLength(2);
  });

  it('states the fallback in the product own voice, above the report', () => {
    expect(markup).toContain('Rendered from template — narration unavailable.');
    expect(markup).toContain('its prose was discarded');
    // And reassures, because nothing is actually missing.
    expect(markup).toContain('Every figure, link and notch below is complete.');
  });

  it('prints the reason, including the token that was rejected', () => {
    expect(markup).toContain('could not be grounded in 3 attempts');
    expect(markup).toContain('#999917');
  });

  it('announces politely rather than assertively', () => {
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
  });

  it('appears above the report body, not buried in the footer', () => {
    expect(markup.indexOf(FALLBACK_NOTE_ATTRIBUTE)).toBeLessThan(markup.indexOf('id="section-yesterday"'));
  });

  it('renders the template renderer six sections as usual', () => {
    const inspection = inspectReportHtml(markup);
    expect(inspection.problems).toEqual([]);
  });
});

describe('an ingested script tag and header injection render as literal text', () => {
  const markup = render(injectionBundle());

  it('executes nothing: no script element reaches the page', () => {
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('</script>');
    expect(markup.toLowerCase()).not.toContain('onerror=');
  });

  it('escapes the angle brackets rather than dropping the title', () => {
    // The report has to be able to say what the ticket is *called* — that is a fact
    // about the manager's board, and deleting it would hide the thing they most need
    // to see.
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('document.cookie');
  });

  it('renders the email-header payload as text with no bare CR or LF', () => {
    expect(markup).toContain('Bcc: attacker@evil.test');
    expect(markup).not.toContain('\r');
  });

  it('does not turn the payload into an attribute or a URL', () => {
    // `evil.test` may appear as text; it must never appear as an href or a src.
    expect(markup).not.toContain('href="https://evil.test');
    expect(markup).not.toContain('src="https://evil.test');
  });

  it('still renders a complete, inspectable report around the payload', () => {
    const inspection = inspectReportHtml(markup);
    expect(inspection.problems).toEqual([]);
  });

  it('keeps the whole payload on the page as one run of escaped text', () => {
    const escaped = INJECTION_TITLE.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      // Whitespace runs collapse to a single space, in a paragraph and in an
      // accessible name alike. Nothing else about the title changes.
      .replace(/\s+/g, ' ');
    expect(markup).toContain(escaped);
  });
});
