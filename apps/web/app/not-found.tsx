import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[40rem] flex-col justify-center px-5 py-24">
      <p className="section-label">404</p>
      <h1 className="mt-3 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
        There is no report at this address.
      </h1>
      <p className="prose-narration mt-4">
        Either the permalink has been revoked, or it never existed. Nothing was logged against your account.
      </p>
      <p className="mt-6">
        <Link
          href="/"
          className="text-[13px] text-ink-faint underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified"
        >
          Back to today&rsquo;s report
        </Link>
      </p>
    </main>
  );
}
