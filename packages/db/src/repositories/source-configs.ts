import { eq } from 'drizzle-orm';

import { deterministicUuid } from '../entity-id.js';
import { toDatabaseInstant } from '../schema/columns.js';
import { sourceConfigs } from '../schema/tables.js';
import type { ScopedDb } from '../scoped-db.js';

import type { Instant } from '@compass/clock';

/**
 * What a manager selected for one configured source, and nothing about its credentials.
 *
 * ## Why the selections live here rather than in a new table
 *
 * `source_configs` is already "a configured data source, named the way the connector port names it",
 * with a `settings` blob and an `enabled` flag. Per-repository, per-project and per-channel scoping *is*
 * that source's configuration — it is the answer to "what did the manager point Compass at" — so a
 * second table would be a second place to look for one fact, and the two would drift the first time a
 * source was renamed.
 *
 * The credential deliberately does **not** live here, and `schema/security.ts` explains why at length:
 * `settings` is read, logged, diffed and returned by the roster endpoints, so a token in it would be one
 * careless serializer away from being published. The split is what makes "no response contains a token"
 * structural rather than a discipline — this module has no `sealedValue` in its vocabulary at all.
 *
 * ## Why `enabled` survives a disconnect
 *
 * Disconnecting deletes the credential and leaves this row alone. That is what lets the freshness
 * indicator say "`primary-code` is disconnected" rather than falling silent: a source with a
 * configuration and no credential is a *stated* state, whereas a source with neither is simply one that
 * was never set up. It also means reconnecting does not ask a manager to pick their repositories again,
 * which is most of the ten minutes the connect flow is measured against.
 */

/** One repository, project or conversation a manager selected. */
export interface SourceSelection {
  /**
   * The provider's own key for the thing — `northwind/checkout-web`, `DEV`, `C04AB12CD34`.
   *
   * Opaque here. This module never parses it, because parsing it would mean knowing which provider
   * wrote it, and that is knowledge the persistence layer has no business holding.
   */
  readonly selectionKey: string;
  /** What a manager calls it, which is what the connect screen and the report show. */
  readonly displayName: string;
}

export interface StoredSourceConfig {
  readonly id: string;
  readonly sourceKey: string;
  /** `code` | `tracker` | `chat`, as the port names them. */
  readonly sourceKind: string;
  /** The connector id whose configuration this is, e.g. `code:github-app-v1`. */
  readonly connectorId: string;
  readonly enabled: boolean;
  readonly selections: readonly SourceSelection[];
  /**
   * Provider-specific settings a connector needs and Compass does not interpret — a tracker's site id,
   * for instance. Opaque strings, kept apart from `selections` so that "what am I reading" and "how do I
   * address it" are not one blob.
   */
  readonly settings: Readonly<Record<string, string>>;
}

export interface SourceConfigInput {
  readonly sourceKey: string;
  readonly sourceKind: string;
  readonly connectorId: string;
  readonly enabled: boolean;
  readonly selections: readonly SourceSelection[];
  readonly settings?: Readonly<Record<string, string>>;
}

/** Deterministic, so a re-save is an update of one row rather than a second row. */
export const sourceConfigRowId = (organizationId: string, sourceKey: string): string =>
  deterministicUuid(`source-config:${organizationId}:${sourceKey}`);

/**
 * The stored blob, read defensively.
 *
 * `settings` is `jsonb`, so it can hold anything a previous version of the code wrote, and this is a
 * system boundary in the sense that matters: the value came out of a database rather than out of a
 * function call. So a malformed entry is dropped rather than coerced — a selection with no key is not a
 * selection, and reading it as one would send an empty repository name to a provider.
 */
function parseSelections(value: unknown): readonly SourceSelection[] {
  if (value === null || typeof value !== 'object') return [];
  const raw = (value as { selections?: unknown }).selections;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const selectionKey = (entry as { selectionKey?: unknown }).selectionKey;
    const displayName = (entry as { displayName?: unknown }).displayName;
    if (typeof selectionKey !== 'string' || selectionKey.length === 0) return [];
    return [
      {
        selectionKey,
        displayName: typeof displayName === 'string' && displayName.length > 0 ? displayName : selectionKey,
      },
    ];
  });
}

function parseSettings(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object') return {};
  const raw = (value as { settings?: unknown }).settings;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};

  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

const toStored = (row: {
  readonly id: string;
  readonly sourceKey: string;
  readonly sourceKind: string;
  readonly connectorId: string;
  readonly enabled: boolean;
  readonly settings: unknown;
}): StoredSourceConfig => ({
  id: row.id,
  sourceKey: row.sourceKey,
  sourceKind: row.sourceKind,
  connectorId: row.connectorId,
  enabled: row.enabled,
  selections: parseSelections(row.settings),
  settings: parseSettings(row.settings),
});

export async function findSourceConfig(scoped: ScopedDb, sourceKey: string): Promise<StoredSourceConfig | null> {
  const rows = await scoped.selectFrom(sourceConfigs, eq(sourceConfigs.sourceKey, sourceKey)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toStored(row);
}

export async function listSourceConfigs(scoped: ScopedDb): Promise<readonly StoredSourceConfig[]> {
  const rows = await scoped.selectFrom(sourceConfigs).orderBy(sourceConfigs.sourceKey);
  return rows.map(toStored);
}

/**
 * Writes one source's configuration, replacing whatever was there.
 *
 * An upsert rather than an insert, because every path that reaches here is stating "this is what Compass
 * reads now": the connect screen's selection form, a reconnect, and a disconnect that flips `enabled`.
 * One row written by one function is what keeps those three from disagreeing about a manager's choices.
 *
 * The selections are stored **as given**, in the manager's order, deliberately: the connect screen lists
 * them back and a re-sorted list would read as though Compass had reinterpreted the choice.
 */
export async function saveSourceConfig(
  scoped: ScopedDb,
  input: SourceConfigInput,
  now: Instant,
): Promise<StoredSourceConfig> {
  const id = sourceConfigRowId(scoped.organizationId, input.sourceKey);
  const at = toDatabaseInstant(now);
  const settings = { selections: input.selections, settings: input.settings ?? {} };

  await scoped
    .insertInto(sourceConfigs, {
      id,
      sourceKey: input.sourceKey,
      sourceKind: input.sourceKind,
      connectorId: input.connectorId,
      enabled: input.enabled,
      settings,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [sourceConfigs.organizationId, sourceConfigs.sourceKey],
      set: {
        sourceKind: input.sourceKind,
        connectorId: input.connectorId,
        enabled: input.enabled,
        settings,
        updatedAt: at,
      },
    })
    .execute();

  const saved = await findSourceConfig(scoped, input.sourceKey);
  if (saved === null) {
    throw new Error(
      `The configuration for ${input.sourceKey} was written but could not be read back, so its state is unknown.`,
    );
  }
  return saved;
}

/**
 * Flips one source between reading and not reading, leaving the selections in place.
 *
 * Returns null when there is no configuration to flip — which is not an error: disconnecting a source
 * that was never connected is a no-op a manager may well perform, and the *act* is still worth an audit
 * record even when there was no row to change.
 */
export async function setSourceConfigEnabled(
  scoped: ScopedDb,
  sourceKey: string,
  enabled: boolean,
  now: Instant,
): Promise<StoredSourceConfig | null> {
  const existing = await findSourceConfig(scoped, sourceKey);
  if (existing === null) return null;

  await scoped
    .updateIn(
      sourceConfigs,
      { enabled, updatedAt: toDatabaseInstant(now) },
      eq(sourceConfigs.sourceKey, sourceKey),
    )
    .execute();

  return await findSourceConfig(scoped, sourceKey);
}
