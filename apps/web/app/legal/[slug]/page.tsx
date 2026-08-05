import { notFound } from 'next/navigation';

import { POLICY_DOCUMENTS } from '@compass/trust';

import { PolicyPage } from '../../../components/policy-document';

/**
 * `/legal/[slug]` — the five published documents, from one module.
 *
 * ## Why one dynamic route and not five pages
 *
 * The five documents differ only in content: same measure, same masthead, same footer. Five near-identical
 * `page.tsx` files would be five places to forget a footer link and five rows in the route matrix. One
 * route renders whichever document the slug names, and `POLICY_DOCUMENTS` is the closed list — a slug that
 * is not in it is a 404 rather than an empty page, because a legal URL that renders a blank document is
 * worse than one that does not resolve.
 *
 * ## This used to be prerendered, and could not stay so
 *
 * It declared `force-static` with a `generateStaticParams` enumerating the five documents. Both are gone,
 * and the reason is the Content-Security-Policy rather than anything about the content: the policy is
 * nonce-based, a nonce exists only per response, and a page whose HTML was produced at build time
 * therefore has script tags with no nonce on them. Because the policy also says `'strict-dynamic'` —
 * which switches off the `'self'` host allowlist — the browser refused *every* script on these
 * documents, so each one loaded with a dead client bundle and a console full of violations. The root
 * layout now reads `headers()` so that every route renders per request; a `force-static` here would
 * override it, and prerendered params would be built for a route that cannot be prerendered.
 *
 * What that costs is the build-time check on the five slugs, which is worth naming rather than glossing:
 * a typo in a link used to fail the build. `tests/legal-content.test.tsx` now collects every
 * `/legal/<slug>` written anywhere in `apps/web` and resolves each against `POLICY_DOCUMENTS`, so the
 * check is the same one at the same stage — a failing assertion instead of a failing prerender, and over
 * more links than the enumeration ever covered.
 */

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  const document = POLICY_DOCUMENTS.find((candidate) => candidate.slug === slug);
  return { title: document === undefined ? 'Not found — Compass' : `${document.title} — Compass` };
}

export default async function LegalDocumentPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  const document = POLICY_DOCUMENTS.find((candidate) => candidate.slug === slug);

  if (document === undefined) notFound();

  return <PolicyPage document={document} />;
}
