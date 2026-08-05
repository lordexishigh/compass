import { headers } from 'next/headers';

import { EnterpriseIdentityScreen } from '../../components/enterprise-identity-screen';
import { StatedFailure } from '../../components/stated-failure';
import { baseUrlFor, pageAccess, scopedFor } from '../../lib/auth/guard';
import { buildEnterpriseIdentityView } from '../../lib/sso-source';

/**
 * `/enterprise` — SAML single sign-on and SCIM provisioning.
 *
 * Owner only, and the plan gate is deliberately *not* applied to reading it. An owner on the Starter plan
 * can read this screen and is told, in the product's voice, what the Business plan would give them and
 * what it would cost them to find out — which is the opposite of a 403 on a page whose whole content is
 * an explanation of a feature they might buy.
 *
 * ## The outcome sentences are looked up here, never taken from the URL
 *
 * `?identity=saml-saved` names an outcome and this maps it to a sentence. The alternative — carrying the
 * sentence in the query string — would let anybody hand somebody a Compass URL that displays arbitrary
 * text in Compass's own typography. `lib/sso-source.ts` records the same reasoning for the SAML refusals.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Single sign-on and provisioning — Compass',
};

/** What each act says once it has happened. Compass's words, keyed by a slug the route chose. */
const OUTCOMES: Readonly<Record<string, string>> = Object.freeze({
  'saml-saved':
    'SAML single sign-on is configured and on. Test it from a private window before you tell the team: ' +
    'sign in at your identity provider and let it send you here.',
  'saml-disabled':
    'SAML single sign-on is off. The certificate is kept so it stays auditable, and nobody can sign in ' +
    'through the identity provider until it is saved again.',
  'token-issued':
    'A provisioning token has been emailed to you. It is not shown on this screen and cannot be ' +
    'recovered — Compass stores only a SHA-256 of it. Paste it into your identity provider, then keep ' +
    'or delete the message as your own policy requires.',
  'token-revoked':
    'That provisioning token no longer works. Any SCIM client still using it will start getting 401s, ' +
    'which is what you want if it was exposed.',
  'token-unknown': 'That token was already revoked, or it does not belong to this organization.',
  'plan-required':
    'SAML and SCIM are part of the Business plan, so that change was not saved. Nothing else about your ' +
    'organization is affected.',
});

function Frame({ heading, children }: { readonly heading: string; readonly children: React.ReactNode }) {
  return (
    <main id="enterprise" className="mx-auto max-w-[68ch] px-4 py-10">
      <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">{heading}</h1>
      <div className="mt-4">{children}</div>
    </main>
  );
}

export default async function EnterprisePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/enterprise', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <Frame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} Nothing about single sign-on has changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  if (!access.allowed) {
    return (
      <Frame heading="Not yours to change">
        <StatedFailure
          detail={
            access.reason ??
            'Single sign-on is the owner’s to configure. It decides who can become a member of this ' +
              'organization, which is not a manager’s decision to make.'
          }
        >
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  const parameters = await searchParams;
  const outcome = typeof parameters['identity'] === 'string' ? parameters['identity'] : null;

  try {
    /**
     * The origin, from configuration.
     *
     * `baseUrlFor` needs a `Request`, and a Server Component has headers rather than one — so a minimal
     * request is constructed from the forwarded host purely to reuse the *one* implementation of the
     * "where does this deployment live" rule. Duplicating that rule here is exactly how an entity id and
     * an ACS URL end up disagreeing with the route that enforces them.
     */
    const forwardedHost = (await headers()).get('x-forwarded-host') ?? (await headers()).get('host');
    const baseUrl = baseUrlFor(
      new Request(`http://${forwardedHost ?? 'localhost:3000'}/enterprise`),
    );

    const view = await buildEnterpriseIdentityView({
      scoped: scopedFor(access.organizationId),
      baseUrl,
    });

    return (
      <EnterpriseIdentityScreen
        view={view}
        stated={outcome === null ? null : (OUTCOMES[outcome] ?? null)}
      />
    );
  } catch (error) {
    return (
      <Frame heading="Compass could not read the single-sign-on configuration">
        <StatedFailure
          detail={`${
            error instanceof Error ? error.message : 'The configuration could not be read.'
          } Nothing has been changed.`}
        >
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }
}
