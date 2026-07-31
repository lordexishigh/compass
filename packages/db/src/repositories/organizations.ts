import { eq } from 'drizzle-orm';

import { organizations } from '../schema/tables.js';
import type { CompassDatabase } from '../scoped-db.js';

/**
 * The tenant root.
 *
 * Every other table carries an `organization_id` that references this one, so
 * the row has to exist before anything else can be written. That makes it the
 * one write in Compass that cannot go through `ScopedDb` — the scope it would be
 * checked against is the row being created.
 *
 * `ensureOrganization` is written to be run on every boot: a cold start creates
 * it, a warm start finds it, and neither path needs an operator to have run a
 * one-off command first. It is not an upsert of the *name* — renaming an
 * organization from a boot script would silently overwrite something a manager
 * had changed in the product.
 */
export interface OrganizationInput {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  /** Supplied by the edge. This layer never reads a clock. */
  readonly at: Date;
}

export interface EnsuredOrganization {
  readonly id: string;
  readonly created: boolean;
}

export async function ensureOrganization(
  database: CompassDatabase,
  input: OrganizationInput,
): Promise<EnsuredOrganization> {
  const existing = await database.select().from(organizations).where(eq(organizations.id, input.id)).limit(1);
  if (existing.length > 0) return { id: input.id, created: false };

  await database
    .insert(organizations)
    .values({
      id: input.id,
      organizationId: input.id,
      name: input.name,
      slug: input.slug,
      timezone: input.timezone,
      createdAt: input.at,
      updatedAt: input.at,
    })
    // Two processes booting at once is the normal case in `docker compose up`:
    // the web app and the worker start together. The loser of the race finds the
    // row rather than crashing the container.
    .onConflictDoNothing()
    .execute();

  return { id: input.id, created: true };
}
