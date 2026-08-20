import { headers } from 'next/headers';

import { StatedFailure } from '../../components/stated-failure';
import { pageAccess, scopedFor } from '../../lib/auth/guard';
import { formatScopeSelections } from '../../lib/connect-scope';
import { buildConnectView, CONNECT_PROVIDER_IDS, type ConnectProviderView } from '../../lib/connect-source';

/**
 * `/connect` — what Compass would read, stated before anybody consents to it.
 *
 * ## Why every permission is imported and not typed out
 *
 * Each provider's permission list comes from its own connector package — `GITHUB_SCOPES`, `JIRA_SCOPES`,
 * `SLACK_SCOPES` — which are the same arrays the install URLs are built from. The criterion is that the
 * requested scopes are "displayed verbatim on the connect screen before consent", and the only way to keep
 * that true is to have one declaration each: a hard-coded list here would keep promising read-only after
 * somebody added a write permission to the request, and both halves would look correct in review.
 *
 * It is the same argument `/pricing` makes for importing `PLANS` rather than printing prices.
 *
 * ## A document, not a wizard
 *
 * One reading column, three sections in a fixed order, and each permission followed by the sentence saying
 * what breaks without it. A consent screen that lists permissions with no justification is a screen nobody
 * can refuse intelligently — so the *reason* is as prominent as the permission, and there is no progress
 * bar, no step counter and no green tick reassuring anybody.
 *
 * The scoping field sits inside each provider's own section rather than on a later step, because it is the
 * same decision as connecting: a manager choosing to connect a code host is choosing *which repositories*,
 * and splitting the two across screens is what turns a two-minute task into a flow people abandon.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Connect a source — Compass',
};

/**
 * The outcomes the callback, the scope form and the disconnect action redirect back with.
 *
 * Written per outcome and not per provider: the sentence is about what happened to a *source*, and three
 * copies differing only in a proper noun is how one of them comes to say something the others do not.
 * `{name}` is substituted with the provider's own name.
 */
const OUTCOME_SENTENCE: Readonly<Record<string, string>> = {
  connected: '{name} is connected. Compass will read what you selected below on the next ingest.',
  disconnected:
    '{name} is disconnected. Compass has stopped reading it; every report it already wrote is unchanged ' +
    'and still readable, and your selection has been kept so reconnecting does not ask for it again.',
  scoped: 'Saved. Compass reads exactly what is listed below for {name}, and nothing else.',
  'scope-rejected':
    'Nothing was saved for {name}, because one of the lines was not something Compass can read. It is ' +
    'quoted below — fix it and save again. A partial save would leave you believing Compass reads more ' +
    'than it does.',
  'state-rejected':
    'That return could not be verified, so nothing was connected. The link Compass sent you expires after ' +
    'ten minutes — start again from this page.',
  'not-configured':
    'This deployment cannot verify an install return yet, so nothing was connected. An operator needs to ' +
    'set the connect state secret.',
  'exchange-failed':
    '{name} returned without a usable credential, so nothing was connected. Nothing has been changed and ' +
    'you can start again.',
  'no-site':
    '{name} granted access but named no site Compass could read, so nothing was connected. Grant access to ' +
    'at least one site and start again.',
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

/** The permission list, verbatim from the connector package. */
function Permissions({ provider }: { readonly provider: ConnectProviderView }) {
  return (
    <>
      <h3 className="mt-5 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
        What Compass asks for
      </h3>
      {/*
        A description list because that is what it is: each permission and the reason it is asked for.
        `data-permission` is what the test reads, so the assertion is against the connector's array rather
        than against prose that could be reworded.
      */}
      <dl className="mt-2 space-y-3">
        {provider.scopes.map((scope) => (
          <div key={scope.label} data-testid="connect-scope" data-permission={scope.label}>
            <dt className="font-mono text-[13px] text-ink">
              <span className="data-token">{scope.label}</span>
            </dt>
            <dd className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-faint">{scope.because}</dd>
          </div>
        ))}
      </dl>

      {provider.refreshScope !== null && (
        <div className="mt-3" data-testid="connect-refresh-scope" data-permission={provider.refreshScope.label}>
          <dt className="font-mono text-[13px] text-ink">
            <span className="data-token">{provider.refreshScope.label}</span>
          </dt>
          <dd className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-faint">
            {provider.refreshScope.because}
          </dd>
        </div>
      )}
    </>
  );
}

/**
 * The scoping field.
 *
 * A plain textarea and a submit, with no client-side JavaScript — the same posture every other write
 * surface in Compass takes. It is also the fastest input for the job: pasting five repository names is one
 * action, whereas a per-repository dialog is five round trips through a modal.
 */
function ScopeForm({ provider, rejectedLine }: { readonly provider: ConnectProviderView; readonly rejectedLine: string | null }) {
  const fieldId = `${provider.providerId}-selections`;

  return (
    <form action={provider.scopePath} method="post" className="mt-5" data-testid="scope-form">
      <label htmlFor={fieldId} className="block font-mono text-[11px] uppercase tracking-wide text-ink-faint">
        {provider.selection.inputLabel}
      </label>
      <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-faint">{provider.selection.inputHint}</p>

      {rejectedLine !== null && (
        <p data-testid="scope-rejected-line" className="stated-absence mt-2 max-w-prose text-[13px] leading-relaxed">
          The line Compass could not read was <span className="data-token">{rejectedLine}</span>.
        </p>
      )}

      <textarea
        id={fieldId}
        name="selections"
        rows={Math.max(3, provider.selections.length + 1)}
        defaultValue={formatScopeSelections(provider.providerId, provider.selections)}
        spellCheck={false}
        data-testid="scope-field"
        className="mt-2 w-full rounded-[8px] border border-rule bg-transparent p-3 font-mono text-[13px] leading-relaxed text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-ink-faint hover:border-rule-strong focus-visible:border-rule-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-verified/40"
      />

      <div className="mt-3 flex flex-wrap items-baseline gap-3">
        <button type="submit" className="tertiary-action" data-testid="scope-submit">
          Save {provider.selection.plural}
        </button>
        <span className="font-mono text-[11px] tabular-nums text-ink-faint">
          {provider.selections.length} selected
        </span>
      </div>
    </form>
  );
}

function ProviderSection({
  provider,
  outcome,
  rejectedLine,
}: {
  readonly provider: ConnectProviderView;
  readonly outcome: string | undefined;
  readonly rejectedLine: string | null;
}) {
  return (
    <section
      aria-labelledby={`${provider.providerId}-heading`}
      data-testid="connect-provider"
      data-provider={provider.providerId}
      data-connected={provider.connected ? 'true' : 'false'}
      data-disconnected={provider.disconnected ? 'true' : 'false'}
      className="mt-8 border-t border-rule pt-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${provider.providerId}-heading`} className="text-[17px] font-medium text-ink-strong">
          {provider.name}
        </h2>
        <span
          data-testid="connect-status"
          className="font-mono text-[11px] uppercase tracking-wide text-ink-faint"
        >
          {provider.connected ? 'connected' : provider.disconnected ? 'disconnected' : 'not connected'}
        </span>
      </div>

      {outcome !== undefined && (
        <p
          data-testid="connect-outcome"
          role="status"
          className="mt-3 border-l-2 border-rule-strong pl-4 text-[14px] leading-relaxed text-ink"
        >
          {outcome}
        </p>
      )}

      <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink">{provider.reads}</p>

      <Permissions provider={provider} />

      {provider.unavailableReason !== null ? (
        <p
          data-testid="connect-unavailable"
          className="stated-absence mt-5 max-w-prose text-[13px] leading-relaxed"
        >
          {provider.unavailableReason}
        </p>
      ) : (
        <>
          {/*
            The scoping field is offered whether or not a credential exists. Choosing repositories and
            then granting access is the order a lot of people work in, and refusing to accept a selection
            until after the grant makes the flow feel like it is arguing with you.
          */}
          <ScopeForm provider={provider} rejectedLine={rejectedLine} />

          {provider.connected ? (
            <>
              <p className="mt-5 max-w-prose text-[13px] leading-relaxed text-ink">
                Disconnecting stops Compass reading {provider.name}. Every report, commit and ticket it has
                already read stays exactly as it is — this is &ldquo;stop reading&rdquo;, not
                &ldquo;forget what you read&rdquo; — and the {provider.selection.plural} above are kept for
                when you reconnect.
              </p>
              <form action={provider.disconnectPath} method="post" className="mt-3">
                <button type="submit" className="tertiary-action" data-testid="disconnect-submit">
                  Disconnect {provider.name}
                </button>
              </form>
            </>
          ) : (
            <form action={provider.installPath} method="post" className="mt-5">
              <button type="submit" className="primary-action" data-testid="install-submit">
                {provider.disconnected ? `Reconnect ${provider.name}` : `Connect ${provider.name}`}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

export default async function ConnectPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The request's own cookie, so the owner-only check can actually see the session. Passing `null` here
  // would refuse every caller including the owner — the page would be unreachable by the one role it
  // exists for, which is exactly the failure `tests/connect-github.test.tsx` caught.
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
          {/*
            Two different refusals reach here, and only one of them has a way forward.

            A signed-in reader whose role is not the owner's is simply told no — there is nothing for
            them to do on this screen. Somebody who is not signed in at all was refused for a reason
            they can act on, and offering only "today's report" left the owner of a fresh deployment
            on a dead end: the screen that connects the sources refused them and did not say where
            the door was.
          */}
          {access.identity === null && (
            <a href="/account" className="tertiary-action">
              sign in
            </a>
          )}
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  const parameters = (await searchParams) ?? {};
  const first = (value: string | string[] | undefined): string | undefined =>
    typeof value === 'string' ? value : undefined;

  // One outcome per provider, keyed by the provider's own query parameter, so a redirect from the tracker
  // states its result inside the tracker's section rather than at the top of a page about three sources.
  const outcomes = Object.fromEntries(
    CONNECT_PROVIDER_IDS.map((providerId) => {
      const key = first(parameters[providerId]);
      const template = key === undefined ? undefined : OUTCOME_SENTENCE[key];
      return [providerId, template] as const;
    }),
  );
  const rejectedLine = first(parameters['line']) ?? null;

  const view = await buildConnectView({ scoped: scopedFor(access.organizationId) });

  return (
    <main id="connect" className="mx-auto max-w-[68ch] px-4 py-10">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">Connect a source</h1>
        <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-ink">
          Compass reads your code host, your tracker and — only where you opt in — named chat channels.
          Everything it asks for is read-only, listed below before you agree to any of it, scoped to the
          repositories, projects and channels you choose, and revocable from this page.
        </p>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink-faint">
          There is no administrator step, no file to upload and no configuration to hand-edit. Nothing here
          is required to try Compass either: the seeded demonstration organization produces a full
          six-section report with no source connected at all.
        </p>
      </header>

      {view.providers.map((provider) => (
        <ProviderSection
          key={provider.providerId}
          provider={provider}
          outcome={outcomes[provider.providerId]?.replaceAll('{name}', provider.name)}
          rejectedLine={outcomes[provider.providerId] === undefined ? null : rejectedLine}
        />
      ))}
    </main>
  );
}
