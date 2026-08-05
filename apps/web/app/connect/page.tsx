import { headers } from 'next/headers';

import { StatedFailure } from '../../components/stated-failure';
import { pageAccess, scopedFor } from '../../lib/auth/guard';
import { buildConnectView, type ConnectProviderView } from '../../lib/connect-source';

/**
 * `/connect` — what Compass would read, stated before anybody consents to it.
 *
 * ## Why the permission list is imported and not typed out
 *
 * Every permission on this page comes from `GITHUB_SCOPES` in `@compass/github-connector`, which is the
 * same array `githubInstallUrl` builds the install request from. The criterion is that the requested
 * scopes are "displayed verbatim on the connect screen before consent", and the only way to keep that
 * true is to have one declaration: a hard-coded list here would keep promising read-only after somebody
 * added a write permission to the request, and both halves would look correct in review.
 *
 * It is the same argument `/pricing` makes for importing `PLANS` rather than printing prices.
 *
 * ## A document, not a wizard
 *
 * One reading column, prose, and each permission followed by the sentence saying what breaks without
 * it. A consent screen that lists permissions with no justification is a screen nobody can refuse
 * intelligently — so the *reason* is as prominent as the permission, and there is no progress bar, no
 * step counter and no green tick reassuring anybody.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Connect a source — Compass',
};

/** The outcomes the callback and the disconnect action redirect back with. */
const OUTCOME_SENTENCE: Readonly<Record<string, string>> = {
  connected: 'GitHub is connected. Compass will read the repositories you selected on the next ingest.',
  disconnected:
    'GitHub is disconnected. Compass has stopped reading it; every report it already wrote is unchanged ' +
    'and still readable.',
  'state-rejected':
    'That install could not be verified, so nothing was connected. The link Compass sent you expires after ' +
    'ten minutes — start again from this page.',
  'not-configured':
    'This deployment cannot verify an install return yet, so nothing was connected. An operator needs to ' +
    'set the connect state secret.',
  'exchange-failed':
    'GitHub returned without an installation, so nothing was connected. Nothing has been changed and you ' +
    'can start again.',
  'storage-failed':
    'The credential could not be stored, so nothing was connected. Compass refuses to hold an OAuth ' +
    'credential it cannot encrypt — an operator needs to set the encryption key.',
};

function Frame({ heading, children }: { readonly heading: string; readonly children: React.ReactNode }) {
  return (
    <main id="connect" className="mx-auto max-w-[68ch] px-4 py-10">
      <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">{heading}</h1>
      <div className="mt-4">{children}</div>
    </main>
  );
}

function ProviderSection({ provider }: { readonly provider: ConnectProviderView }) {
  return (
    <section
      aria-labelledby={`${provider.providerId}-heading`}
      data-testid="connect-provider"
      data-provider={provider.providerId}
      data-connected={provider.connected ? 'true' : 'false'}
      className="mt-8 border-t border-rule pt-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${provider.providerId}-heading`} className="text-[17px] font-medium text-ink-strong">
          {provider.name}
        </h2>
        <span className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
          {provider.connected ? 'connected' : 'not connected'}
        </span>
      </div>

      <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink">
        Compass reads commits, pull requests, reviews, branch tips and release tags from the repositories
        you select — and nothing else. It never pushes a commit, opens a pull request, changes a setting
        or installs a webhook.
      </p>

      {/*
        The permission list, verbatim from the connector package.
        Rendered as a description list because that is what it is: each permission and the reason it is
        asked for. `data-permission` is what the test reads, so the assertion is against the array rather
        than against prose that could be reworded.
      */}
      <h3 className="mt-5 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
        What Compass asks for
      </h3>
      <dl className="mt-2 space-y-3">
        {provider.scopes.map((scope) => (
          <div key={scope.permission} data-testid="connect-scope" data-permission={scope.permission}>
            <dt className="font-mono text-[13px] text-ink">
              <span className="data-token">
                {scope.permission}:{scope.access}
              </span>
            </dt>
            <dd className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-faint">{scope.because}</dd>
          </div>
        ))}
      </dl>

      {provider.unavailableReason !== null ? (
        <p data-testid="connect-unavailable" className="stated-absence mt-5 max-w-prose text-[13px] leading-relaxed">
          {provider.unavailableReason}
        </p>
      ) : provider.connected ? (
        <>
          <p className="mt-5 max-w-prose text-[13px] leading-relaxed text-ink">
            Disconnecting stops Compass reading GitHub. Every report, commit and pull request it has
            already read stays exactly as it is — this is &ldquo;stop reading&rdquo;, not
            &ldquo;forget what you read&rdquo;.
          </p>
          <form action="/api/connect/github/disconnect" method="post" className="mt-3">
            <button type="submit" className="tertiary-action" data-testid="disconnect-submit">
              Disconnect GitHub
            </button>
          </form>
        </>
      ) : (
        <form action="/api/connect/github/install" method="post" className="mt-5">
          <button type="submit" className="primary-action" data-testid="install-submit">
            Connect GitHub
          </button>
        </form>
      )}
    </section>
  );
}

export default async function ConnectPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The request's own cookie, so the owner-only check can actually see the session. Passing `null`
  // here would refuse every caller including the owner — the page would be unreachable by the one
  // role it exists for, which is exactly the failure `tests/connect-github.test.tsx` caught.
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/connect', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <Frame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} No source has been connected or disconnected.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  if (!access.allowed) {
    return (
      <Frame heading="Not yours to connect">
        <StatedFailure
          detail={
            access.reason ??
            'Connecting a data source decides what Compass reads about the whole organization, so it is the ' +
              'owner’s to do. Your role can read every report Compass writes from it.'
          }
        >
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  const outcomeKey = (await searchParams)?.['github'];
  const outcome = typeof outcomeKey === 'string' ? OUTCOME_SENTENCE[outcomeKey] : undefined;

  const view = await buildConnectView({ scoped: scopedFor(access.organizationId) });

  return (
    <main id="connect" className="mx-auto max-w-[68ch] px-4 py-10">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">Connect a source</h1>
        <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-ink">
          Compass reads your code host, your tracker and — only where you opt in — named chat channels.
          Everything it asks for is read-only, listed below before you agree to any of it, and revocable
          from this page.
        </p>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink-faint">
          Nothing here is required to try Compass. The seeded demonstration organization produces a full
          six-section report with no source connected at all.
        </p>
      </header>

      {outcome !== undefined && (
        <p
          data-testid="connect-outcome"
          role="status"
          className="mt-6 border-l-2 border-rule-strong pl-4 text-[14px] leading-relaxed text-ink"
        >
          {outcome}
        </p>
      )}

      {view.providers.map((provider) => (
        <ProviderSection key={provider.providerId} provider={provider} />
      ))}

      <section aria-labelledby="later-heading" className="mt-10 border-t border-rule pt-6">
        <h2 id="later-heading" className="text-[15px] font-medium text-ink-strong">
          Jira and Slack
        </h2>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink-faint">
          Not yet connectable. Compass states that rather than showing a button that does nothing: the
          tracker and chat connectors are built against the same read-only, per-project and
          per-channel rules GitHub follows here, and this page will list their permissions the same way
          before anybody consents to them.
        </p>
      </section>
    </main>
  );
}
