import type { Metadata, Viewport } from 'next';

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

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
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
      </body>
    </html>
  );
}
