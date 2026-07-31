import type { Metadata } from 'next';

import { ArtifactDetail } from '../../../../components/artifact-detail';
import { loadArtifactView } from '../../../../lib/artifact-source';

/**
 * `/artifact/<kind>/<id>` — where every evidence marker lands.
 *
 * The segment names are not chosen here: `artifactHref` in `@compass/pipeline`
 * builds the path and this route has to match it, so the two live and change
 * together. A mismatch would produce dead links that still satisfy any test
 * asserting only that a link is present.
 *
 * Params are a Promise in Next.js 15 and are awaited, not read synchronously.
 * They arrive percent-decoded, so nothing here decodes them a second time — an
 * artifact id containing a literal `%` would not survive the round trip.
 */
export const dynamic = 'force-dynamic';

interface ArtifactParams {
  readonly kind: string;
  readonly artifactId: string;
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<ArtifactParams>;
}): Promise<Metadata> {
  const { kind, artifactId } = await params;
  return { title: `${kind} ${artifactId} — Compass` };
}

export default async function ArtifactPage({ params }: { readonly params: Promise<ArtifactParams> }) {
  const { kind, artifactId } = await params;
  const artifact = await loadArtifactView(kind, artifactId);

  return <ArtifactDetail artifact={artifact} />;
}
