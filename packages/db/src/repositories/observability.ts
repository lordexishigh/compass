import type { Instant } from '@compass/clock';
import { and, eq, sql } from 'drizzle-orm';

import { fromNullableDatabaseInstant } from '../schema/columns.js';
import { deliveryLog } from '../schema/delivery.js';
import { ingestRuns } from '../schema/tables.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * Whether the deployment has actually *done* anything lately, per organization.
 *
 * These are deliberately not the same question as the readiness checks beside them in
 * `apps/web/lib/health.ts`. A check says whether a capability is *configured* — a mailer exists, a
 * database answers. These say whether it has *worked*, which is the only thing that distinguishes a
 * healthy deployment from one where every dependency is green and the worker has been dead since
 * Tuesday.
 *
 * Each is a "when did this last succeed" rather than a boolean, for one reason: a boolean derived
 * from a threshold bakes somebody's idea of "recently" into the payload, and the operator reading it
 * at 2am has a better one.
 *
 * Queue depth is the third field on that payload and is *not* here — it has no organization, so it
 * lives in `src/queue-depth.ts` rather than being given a scope parameter it has nothing to do with.
 */

/**
 * When this organization last completed an ingest, or null if it never has.
 *
 * `status = 'complete'` only. A `partial` or `unavailable` run genuinely happened and is in the
 * journal, but it is not the thing an operator is asking about: "when did Compass last see all of
 * your data" is the question, and answering it with a run that read half of one source would be the
 * reassuring answer rather than the true one.
 */
export async function lastSuccessfulIngestAt(scoped: ScopedDb): Promise<Instant | null> {
  const rows = await scoped
    .selectFrom(ingestRuns, eq(ingestRuns.status, 'complete'))
    .orderBy(sql`${ingestRuns.completedAt} desc nulls last`)
    .limit(1);

  return fromNullableDatabaseInstant(rows.at(0)?.completedAt ?? null);
}

/**
 * When this organization last had a report actually delivered, or null.
 *
 * `status = 'sent'`, so a `deferred` or `failed` attempt does not count — and neither does
 * `skipped`, which is what an unconfigured transport records. A deployment with no `RESEND_API_KEY`
 * writes a row per due delivery saying it sent nothing; treating those as deliveries would make the
 * field read healthiest on the deployment that has never delivered anything.
 */
export async function lastSuccessfulDeliveryAt(scoped: ScopedDb): Promise<Instant | null> {
  const rows = await scoped
    .selectFrom(deliveryLog, eq(deliveryLog.status, 'sent'))
    .orderBy(sql`${deliveryLog.recordedAt} desc`)
    .limit(1);

  return fromNullableDatabaseInstant(rows.at(0)?.recordedAt ?? null);
}

/** The count of deliveries this organization has failed outright on one date, for the same payload. */
export async function failedDeliveryCount(scoped: ScopedDb, deliveryDate: string): Promise<number> {
  const rows = await scoped.selectFrom(
    deliveryLog,
    and(eq(deliveryLog.status, 'failed'), eq(deliveryLog.deliveryDate, deliveryDate)),
  );
  return rows.length;
}
