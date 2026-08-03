import { UndoDeletionPanel } from '../../../components/undo-deletion-panel';

/**
 * `/account/deletion` — the page a mailed undo link lands on.
 *
 * ## Why a page and not a link straight to the endpoint
 *
 * The endpoint is a POST, on purpose: a mail client's link scanner or preview fetcher must
 * not cancel somebody's deletion by looking at the message, which is the same reasoning RFC
 * 8058 gives for one-click unsubscribe. But a person clicking a link in an email produces a
 * GET. So the link lands here, this page reads the token out of the query string, and one
 * button posts it. The human still clicks once.
 *
 * ## Why it holds no data
 *
 * Nothing on this page is read from the organization. It renders a token from the URL, a
 * button, and whatever sentence the endpoint answers with — which is why it can be `ANYONE`
 * in the matrix with no `demoOnlyPublic` flag. Somebody in the middle of a deletion may well
 * be unable to sign in; a page that required a session would be unusable in the one case it
 * exists for.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Cancel a deletion — Compass',
};

export default async function DeletionUndoPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params['undo'];
  const token = typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : '';

  return (
    <div className="mx-auto w-full max-w-[38rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">deletion</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          Cancel this deletion
        </h1>
        <p className="prose-narration mt-3">
          Nothing has been deleted. Confirming below stops the deletion and leaves everything exactly as it was — no
          data was touched while the request was pending.
        </p>
      </header>

      <div className="mt-8">
        <UndoDeletionPanel token={token} />
      </div>

      <p className="mt-10 flex flex-wrap gap-x-5 text-[13px]">
        <a href="/" className="tertiary-action">
          ← today&apos;s report
        </a>
        <a href="/account" className="tertiary-action">
          your account
        </a>
      </p>
    </div>
  );
}
