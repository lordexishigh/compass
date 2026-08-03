import { FirstReportGuide } from '../components/first-report-guide';
import { ReportDocument } from '../components/report-document';
import { loadHomeView } from '../lib/report-source';

/**
 * `/` — today's report.
 *
 * A Server Component with no `'use client'` anywhere above it: the report is
 * assembled on the server and arrives as HTML, which is why a manager on a phone
 * on a train reads prose rather than a spinner.
 *
 * No login wall, no connector wizard, no redirect. If nobody has generated today's
 * report yet — the normal case on a cold container — the read path generates it,
 * which is the whole of the zero-config promise.
 *
 * There is exactly one other thing this route can render, and it is not an empty
 * state. An organization with no team and nobody on it has no *subject* for a
 * report, and six empty headings over it would assert a quiet team where there is
 * none. That case names what is missing and links to `/start`. A quiet day is
 * unaffected: it still renders six sections with the absences stated, which is what
 * `tests/cold-start.test.tsx` holds this route to.
 */
export const dynamic = 'force-dynamic';

export default async function ReportPage() {
  const home = await loadHomeView();

  if (home.kind === 'unprovisioned') {
    return <FirstReportGuide steps={home.steps} reportExists={home.reportExists} />;
  }

  return <ReportDocument view={home.view} />;
}
