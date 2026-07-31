/**
 * @compass/seed-connector — the MVP runtime substrate.
 *
 * Layer position: beside the port, above nothing. Only the process edge may
 * import this package: an architecture rule forbids ingest, the knowledge model,
 * analysis, the renderers and the pipeline from referring to it, so no code path
 * below the port can know a seeded provider exists.
 */
export { SeedConnector } from './seed-connector.js';
export { foundationDataset, FOUNDATION_WINDOW, FOUNDATION_UNAVAILABLE_SOURCE_KEY } from './foundation-dataset.js';
export type { SeedDataset, SeedRecords, SeedSource } from './dataset.js';
