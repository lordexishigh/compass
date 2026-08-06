import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';

import { AppFeedbackControl } from '../components/app-feedback-control';

import './globals.css';

export const metadata: Metadata = {
  title: 'Compass',
  description:
    'One prose daily report — Yesterday, Progress, Blockers, Risks, Recommendations, Wins — for a manager of one to three teams.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
};

/**
 * Reading the nonce is what keeps every page renderable under the CSP.
 *
 * ## Why a header read lives in the root layout
 *
 * The policy `middleware.ts` sends is nonce-based, and a nonce is minted per response. A page that
 * Next *prerenders* has its HTML built at a moment when no middleware ran and no nonce existed, so
 * its script tags carry none — and because the policy says `'strict-dynamic'`, which switches off
 * the `'self'` host allowlist, the browser then refuses **every** script on it: the framework
 * bootstrap, every chunk, hydration, the lot. That is not a theory. Before this read existed,
 * `/pricing`, `/legal`, `/legal/[slug]`, `/trust/subprocessors` and the 404 shell were prerendered,
 * and a production load of each one filled the console with about twenty refusals.
 *
 * `headers()` is a dynamic API, so reading it here — in the one layout every route is nested inside
 * — opts the whole app out of static generation and makes "the nonce in the HTML is the nonce in the
 * header" true by construction. Next.js documents this constraint the same way round: a
 * middleware-generated nonce requires dynamic rendering.
 *
 * The alternative was `export const dynamic = 'force-dynamic'` on each content page. Rejected
 * because it is the same fix written five times and forgotten on the sixth: the next static page
 * somebody adds would ship with its JavaScript silently blocked, and nothing would say so.
 *
 * ## Nothing is taken out of the headers, on purpose
 *
 * The call is the mechanism; there is no value this layout needs. Next stamps the nonce onto its own
 * script tags from the request CSP header, and this layout renders no inline script of its own — so
 * the nonce is deliberately never bound or rendered here. Putting it in an attribute would undo what
 * it is for: an attacker who can inject markup but not script can read an attribute back with a CSS
 * selector, which is why browsers hide the `nonce` attribute on script tags in the first place. A
 * layout that one day does render an inline script reads `NONCE_HEADER` from
 * `lib/security-headers.ts` at this line and passes it to that tag, and nowhere else.
 */
export default async function RootLayout({ children }: { readonly children: React.ReactNode }) {
  // The call is load-bearing and its value is not — deleting this line puts every content page back
  // to being prerendered with a nonce it cannot have. See above.
  await headers();

  return (
    <html lang="en">
      <body className="min-h-dvh bg-surface text-ink antialiased">
        <a
          href="#report"
          className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4 focus-visible:z-50 focus-visible:rounded-lg focus-visible:bg-surface-raised focus-visible:px-3 focus-visible:py-2 focus-visible:text-[13px] focus-visible:text-ink-strong focus-visible:shadow-sm"
        >
          Skip to the report
        </a>
        {children}
        {/*
          Mounted here rather than inside `ReportDocument`, which is what makes it reachable from
          *both* report views — today's report at `/` and any archived permalink at
          `/archive/[reportId]` — as well as the weekly digest and the merged view, without four
          copies that can drift apart. It is the last child so it follows the document in the tab
          order: a control a manager reaches after reading, never before.

          `/` stays session-less. This is a leaf `'use client'` boundary under a Server Component
          layout, so the report is still assembled on the server and arrives as HTML; the pill's own
          endpoint allows the `public` principal, so the demonstration reader can use it with no
          session at all.
        */}
        <AppFeedbackControl />
      </body>
    </html>
  );
}
