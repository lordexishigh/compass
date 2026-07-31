import { instantFromIso } from '@compass/clock';
import { describeConnectorContract } from '@compass/connector-port/testkit';

import {
  FOUNDATION_UNAVAILABLE_SOURCE_KEY,
  FOUNDATION_WINDOW,
  SeedConnector,
} from '@compass/seed-connector';

/**
 * The seeded provider runs the shared conformance suite unmodified — the same
 * suite a live GitHub or Jira connector will have to pass.
 */
describeConnectorContract({
  name: 'SeedConnector',
  createConnector: () => new SeedConnector(),
  organizationId: '00000000-0000-4000-8000-000000000001',
  window: FOUNDATION_WINDOW,
  now: instantFromIso('2026-07-31T08:00:00Z'),
  splitAt: instantFromIso('2026-07-29T00:00:00Z'),
  unavailableSourceKey: FOUNDATION_UNAVAILABLE_SOURCE_KEY,
});
