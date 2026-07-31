import { instantFromIso } from '@compass/clock';
import { describeConnectorContract } from '@compass/connector-port/testkit';

import { SeedConnector, loadSeedBundle, resolveSeedDirectory } from '@compass/seed-connector';

/**
 * The seeded provider runs the shared conformance suite unmodified — the same
 * suite a live GitHub or Jira connector will have to pass — over the full seed
 * dataset rather than the small foundation fixture.
 *
 * Nothing seed-specific is passed in beyond the fixture window and the source
 * the dataset declares as down. If this passes and a live provider passes, the
 * pipeline genuinely cannot tell which answered.
 */
const bundle = loadSeedBundle(resolveSeedDirectory());

describeConnectorContract({
  name: 'SeedConnector over the seeded dataset',
  createConnector: () => new SeedConnector(bundle.dataset),
  organizationId: bundle.organizationId,
  window: bundle.window,
  now: bundle.now,
  // Mid-way through the fourth sprint: both halves hold records of every family.
  splitAt: instantFromIso('2026-06-29T00:00:00Z'),
  ...(bundle.unavailableSourceKey === null ? {} : { unavailableSourceKey: bundle.unavailableSourceKey }),
});
