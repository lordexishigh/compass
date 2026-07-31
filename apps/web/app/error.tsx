'use client';

import { useEffect } from 'react';

/**
 * Page-level failure, in the same single-column voice: one sentence, one
 * tertiary action. No illustrated error art, no apologetic mascot.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    console.error('[compass] page failed to render:', error.message);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[40rem] flex-col justify-center px-5 py-24">
      <p className="section-label">Interrupted</p>
      <h1 className="mt-3 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
        This report could not be assembled.
      </h1>
      <p className="prose-narration mt-4">
        Nothing was changed and nothing was sent. The failure was recorded
        {error.digest ? (
          <>
            {' '}
            under <span className="data-token">{error.digest}</span>
          </>
        ) : null}
        .
      </p>
      <p className="mt-6">
        <button
          type="button"
          onClick={reset}
          className="text-[13px] text-ink-faint underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified focus-visible:outline-2"
        >
          Try assembling it again
        </button>
      </p>
    </main>
  );
}
