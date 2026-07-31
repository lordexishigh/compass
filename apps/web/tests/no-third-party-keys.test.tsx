import { SECTIONS } from '@compass/analysis';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReportDocument } from '../components/report-document';
import { buildReportView } from '../lib/view-model';

import { freshnessComplete, storedBundle } from './helpers/report-fixture';

/**
 * The whole product, with no third-party key set at all.
 *
 * The zero-config promise is not "the health endpoint answers" — it is that a manager opens `/` on
 * a container with no Anthropic key, no Resend key and no Slack token and reads a complete
 * six-section report. So this test renders the *page* rather than probing readiness: an assertion
 * that `/api/health` returns 200 would have passed even in a build where the report itself failed
 * to render, which is precisely the failure worth guarding.
 *
 * Each absent key costs exactly one thing, and none of them is the report:
 *
 *  - no `ANTHROPIC_API_KEY` — the deterministic template renderer writes every sentence, which is
 *    the primary renderer rather than a degraded mode;
 *  - no `RESEND_API_KEY` / `COMPASS_EMAIL_FROM` — the daily is not emailed, and a scheduled
 *    delivery records `skipped` naming the variable;
 *  - no `SLACK_BOT_TOKEN` — the same for Slack.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  for (const variable of [
    'ANTHROPIC_API_KEY',
    'RESEND_API_KEY',
    'COMPASS_EMAIL_FROM',
    'SLACK_BOT_TOKEN',
    'SLACK_SIGNING_SECRET',
  ]) {
    delete process.env[variable];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('/ with no third-party keys configured', () => {
  const markup = (): string =>
    renderToStaticMarkup(
      <ReportDocument view={buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() })} />,
    );

  it('renders the seeded report rather than an empty state', () => {
    const html = markup();

    expect(html.length, 'the page rendered nothing at all').toBeGreaterThan(1_000);
    expect(html).not.toMatch(/something went wrong/i);
    expect(html).not.toMatch(/failed to load/i);
  });

  it('still renders all six sections, in the fixed order', () => {
    const html = markup();

    for (const definition of SECTIONS) {
      expect(html, `${definition.key} is missing with no keys set`).toContain(definition.title);
    }

    const positions = SECTIONS.map((definition) => html.indexOf(definition.title));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('names the deterministic renderer rather than claiming narration happened', () => {
    // Honest degradation: with no Anthropic key nothing was attempted, so the page must not
    // present templated prose as narrated.
    const view = buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() });
    expect(view.rendererId).toBe('template');
  });

  it('does not require a delivery transport to render', () => {
    // The report and its delivery are separate capabilities. A missing Resend key must not reach
    // the reading column at all.
    const html = markup();
    expect(html).not.toContain('RESEND_API_KEY');
    expect(html).not.toContain('SLACK_BOT_TOKEN');
  });
});

describe('readiness with no third-party keys', () => {
  it('names each missing delivery capability without failing', async () => {
    // The other half: the page renders, *and* an operator can find out why no email arrived.
    const { readiness } = await import('../lib/health');
    const report = await readiness();

    const mail = report.checks.find((check) => check.name === 'mail');
    const slack = report.checks.find((check) => check.name === 'slack');

    expect(mail?.status).toBe('not_configured');
    expect(mail?.detail).toContain('RESEND_API_KEY');
    expect(slack?.status).toBe('not_configured');
    expect(slack?.detail).toContain('SLACK_BOT_TOKEN');
    // `not_configured`, never `degraded`: nothing is broken.
    expect(report.checks.some((check) => check.status === 'degraded' && check.name === 'mail')).toBe(false);
  });
});
