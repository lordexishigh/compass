import { ReportDocument } from '../components/report-document';
import { loadReportView } from '../lib/report-source';

/**
 * `/` — today's report.
 *
 * A Server Component with no `'use client'` anywhere above it: the report is
 * assembled on the server and arrives as HTML, which is why a manager on a phone
 * on a train reads prose rather than a spinner.
 *
 * No login wall, no connector wizard, no empty state. If nobody has generated
 * today's report yet — the normal case on a cold container — the read path
 * generates it, which is the whole of the zero-config promise.
 */
export const dynamic = 'force-dynamic';

export default async function ReportPage() {
  const view = await loadReportView();

  return <ReportDocument view={view} />;
}
