import { PLANS } from '@compass/billing';

import type { EnterpriseIdentityView } from '../lib/sso-source';

/**
 * `/enterprise` — SAML single sign-on and SCIM provisioning, as a page of prose.
 *
 * ## Why this is a document and not a settings form
 *
 * The design brief says the reading column is the product, and that holds here more than it looks like
 * it should. Configuring SAML is a *conversation between two consoles*: an administrator has this page
 * open in one tab and Okta or Entra in another, and what they need is to be told which value goes where,
 * in the order the other console asks for them. A grid of labelled inputs makes them hunt; a numbered
 * list of sentences with a copyable value in each does not.
 *
 * So the two values Compass supplies come first, in mono, before the form that asks for anything —
 * because that is the order the work actually happens in.
 *
 * ## Colour is rationed, including here
 *
 * Emerald marks one thing on this page: a connection that is verified and live. Everything else — a
 * plan that does not include SAML, a disabled connection, a revoked token — is carried by zinc, weight
 * and rule thickness. A "not on your plan" notice in amber would be Compass colour-coding bad news,
 * which the brief refuses.
 */

/** The plan that carries enterprise identity, named from the plan table rather than typed. */
const ENTERPRISE_PLAN_NAME = PLANS.find((plan) => plan.includesEnterpriseIdentity)?.name ?? 'Business';

export interface EnterpriseIdentityScreenProps {
  readonly view: EnterpriseIdentityView;
  /** The outcome of the last act, already turned into a sentence by the page. */
  readonly stated?: string | null;
}

/**
 * A value the administrator copies into the other console.
 *
 * Not a `<input readonly>`, which is what a settings form would reach for: an input implies the value is
 * editable and puts a border round something that is really a fact. This is a definition list entry with
 * the value in mono, selectable, and it reads as what it is.
 */
function SuppliedValue({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="mt-5">
      <dt className="section-label">{label}</dt>
      <dd className="mt-1.5 break-all font-mono text-[13px] leading-relaxed text-ink-strong select-all">
        {value}
      </dd>
    </div>
  );
}

export function EnterpriseIdentityScreen({ view, stated = null }: EnterpriseIdentityScreenProps) {
  return (
    <main id="enterprise" className="mx-auto max-w-[68ch] px-4 py-10">
      <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">
        Single sign-on and provisioning
      </h1>

      <p className="mt-4 leading-relaxed text-ink">
        Compass federates to one identity provider per organization over SAML 2.0, and accepts user
        provisioning over SCIM 2.0. Passwords, emailed links, Google and GitHub keep working alongside
        it — turning this on adds a way in rather than replacing the others.
      </p>

      {stated !== null && (
        <p
          // `role="status"` so a screen reader hears the outcome of a form post without moving focus.
          role="status"
          className="mt-6 border-l-2 border-l-[color:var(--rule-strong)] pl-4 leading-relaxed text-ink"
        >
          {stated}
        </p>
      )}

      {!view.allowed && (
        <section aria-labelledby="plan-gate" className="mt-8">
          <h2 id="plan-gate" className="section-label">
            not on this plan
          </h2>
          {/* Zinc and a rule, not amber. Compass never colour-codes bad news. */}
          <p className="mt-3 border-l-2 border-l-[color:var(--rule-strong)] pl-4 leading-relaxed text-ink">
            {view.blockedStatement}
          </p>
          <p className="mt-4">
            <a href="/billing" className="tertiary-action">
              change plan →
            </a>
          </p>
        </section>
      )}

      {/* ------------------------------------------------------------------
          What Compass supplies. First, because it is the first thing needed.
          ------------------------------------------------------------------ */}
      <section aria-labelledby="supplied" className="mt-10 border-t border-t-[color:var(--rule)] pt-8">
        <h2 id="supplied" className="text-[15px] font-medium text-ink-strong">
          1. Paste these into your identity provider
        </h2>
        <p className="mt-2 leading-relaxed text-ink">
          Your provider will ask for an entity ID (sometimes called an audience or identifier) and a
          reply URL (sometimes an ACS or single-sign-on URL). These are Compass&apos;s.
        </p>

        <dl>
          <SuppliedValue label="entity id / audience" value={view.entityId} />
          <SuppliedValue label="reply url / acs" value={view.acsUrl} />
        </dl>

        <p className="mt-5 leading-relaxed text-ink">
          Compass requires <strong className="font-medium text-ink-strong">signed assertions</strong> —
          response signing alone is not enough, because a signature over the envelope says nothing about
          which assertion inside it to trust. Sign with RSA-SHA256 and exclusive canonicalisation;
          SHA-1 is refused. Assertion encryption is not supported and must be off.
        </p>

        <p className="mt-4">
          <a href={view.metadataUrl} className="tertiary-action">
            service-provider metadata (xml) →
          </a>
        </p>
      </section>

      {/* ------------------------------------------------------------------
          The IdP side.
          ------------------------------------------------------------------ */}
      <section aria-labelledby="idp" className="mt-10 border-t border-t-[color:var(--rule)] pt-8">
        <h2 id="idp" className="text-[15px] font-medium text-ink-strong">
          2. Tell Compass about your identity provider
        </h2>

        {view.saml.configured ? (
          <div className="mt-4">
            <p className="leading-relaxed text-ink">
              {view.saml.enabled ? (
                <>
                  SAML is{' '}
                  {/* The one emerald on this page: a live, verified connection. */}
                  <strong className="font-medium text-[color:var(--verified-text)]">on</strong> for this
                  organization.
                </>
              ) : (
                <>
                  SAML is <strong className="font-medium text-ink-strong">off</strong>. The certificate
                  below is kept so it stays auditable; nobody can sign in through the provider until it
                  is saved again.
                </>
              )}
            </p>

            <dl>
              <SuppliedValue label="provider entity id" value={view.saml.idpEntityId ?? '—'} />
              <SuppliedValue label="provider sign-in url" value={view.saml.idpSsoUrl ?? '—'} />
              <SuppliedValue
                label="signing certificate — sha-1 fingerprint"
                value={view.saml.certificateFingerprint ?? '—'}
              />
            </dl>

            <p className="stated-absence mt-4 text-[13px] leading-relaxed">
              The fingerprint is shown rather than the certificate. The certificate is public, so this is
              not secrecy — it is that comparing forty characters against your provider&apos;s console
              answers the only question anybody asks here, and comparing fourteen hundred does not.
            </p>

            <p className="mt-3 leading-relaxed text-ink">
              A seat created by this provider becomes a{' '}
              <span className="data-token">{view.saml.defaultRole ?? 'member'}</span>. Never an owner —
              otherwise anybody who can add a user to a directory group could take over this
              organization.
            </p>
          </div>
        ) : (
          <p className="stated-absence mt-4 leading-relaxed">
            No identity provider is configured, so SAML sign-in is not available for this organization.
          </p>
        )}

        {/* The form. `method="post"` to a route that answers 303, so no client JavaScript is needed. */}
        <form
          method="post"
          action="/api/enterprise/identity"
          className="mt-7 border-t border-t-[color:var(--rule)] pt-6"
        >
          <input type="hidden" name="intent" value="saml" />

          <fieldset disabled={!view.allowed} className="border-0 p-0 disabled:opacity-55">
            <legend className="section-label">
              {view.saml.configured ? 'replace the provider' : 'add a provider'}
            </legend>

            <label className="mt-4 block" htmlFor="idpEntityId">
              <span className="section-label">provider entity id</span>
            </label>
            <input
              id="idpEntityId"
              name="idpEntityId"
              type="text"
              required
              defaultValue={view.saml.idpEntityId ?? ''}
              placeholder="https://sts.windows.net/00000000-0000-0000-0000-000000000000/"
              className="goal-input"
              autoComplete="off"
            />

            <label className="mt-5 block" htmlFor="idpSsoUrl">
              <span className="section-label">provider sign-in url (https)</span>
            </label>
            <input
              id="idpSsoUrl"
              name="idpSsoUrl"
              type="url"
              required
              defaultValue={view.saml.idpSsoUrl ?? ''}
              placeholder="https://login.microsoftonline.com/…/saml2"
              className="goal-input"
              autoComplete="off"
            />

            <label className="mt-5 block" htmlFor="idpCertificate">
              <span className="section-label">signing certificate (base64 x.509)</span>
            </label>
            <textarea
              id="idpCertificate"
              name="idpCertificate"
              required
              rows={5}
              placeholder="MIIDdzCCAl+gAwIBAgIE…"
              className="goal-input font-mono text-[12px]"
              aria-describedby="certificate-hint"
            />
            <p id="certificate-hint" className="stated-absence mt-2 text-[13px]">
              Paste it with or without the BEGIN and END lines. Compass stores it as base64 either way.
            </p>

            <label className="mt-5 block" htmlFor="defaultRole">
              <span className="section-label">role for a seat this provider creates</span>
            </label>
            <select
              id="defaultRole"
              name="defaultRole"
              defaultValue={view.saml.defaultRole ?? 'member'}
              className="goal-input"
            >
              <option value="manager">manager — reads and edits their teams</option>
              <option value="member">member — reads their teams&apos; reports</option>
              <option value="viewer">viewer — reads, and nothing else</option>
            </select>

            <div className="mt-7 flex flex-wrap items-center gap-5">
              <button type="submit" className="primary-action">
                {view.saml.configured ? 'Save provider' : 'Enable SAML'}
              </button>
            </div>
          </fieldset>
        </form>

        {view.saml.enabled && (
          <form method="post" action="/api/enterprise/identity" className="mt-5">
            {/* An HTML form can only POST, so the withdrawal is a named intent rather than a method
                override — the same shape the two configuring acts use. The route runs one function for
                this and for a `DELETE` from an API caller. */}
            <input type="hidden" name="intent" value="saml_disable" />
            <button type="submit" className="tertiary-action">
              turn SAML off
            </button>
          </form>
        )}
      </section>

      {/* ------------------------------------------------------------------
          SCIM.
          ------------------------------------------------------------------ */}
      <section aria-labelledby="scim" className="mt-10 border-t border-t-[color:var(--rule)] pt-8">
        <h2 id="scim" className="text-[15px] font-medium text-ink-strong">
          3. Provisioning over SCIM
        </h2>

        <p className="mt-2 leading-relaxed text-ink">
          Point your provider&apos;s SCIM client at the URL below with a token from this screen. When it
          deprovisions somebody, Compass revokes every session they hold and frees their seat
          immediately — not on the next sync.
        </p>

        <dl>
          <SuppliedValue label="scim base url" value={view.scim.usersUrl} />
        </dl>

        <h3 className="section-label mt-8">tokens</h3>
        {view.scim.credentials.length === 0 ? (
          <p className="stated-absence mt-3 leading-relaxed">
            No provisioning token has been issued, so no SCIM client can reach this organization.
          </p>
        ) : (
          <ul className="mt-3">
            {view.scim.credentials.map((credential) => (
              <li
                key={credential.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-b-[color:var(--rule)] py-3"
              >
                <span className="text-ink-strong">{credential.label}</span>
                <span className="stated-absence text-[13px]">
                  {credential.revokedAt !== null
                    ? 'revoked'
                    : credential.lastUsedAt === null
                      ? 'never used'
                      : `last used ${new Date(credential.lastUsedAt).toISOString().slice(0, 10)}`}
                </span>
                {credential.revokedAt === null && (
                  <form method="post" action="/api/enterprise/identity">
                    <input type="hidden" name="intent" value="scim_token_revoke" />
                    <input type="hidden" name="credentialId" value={credential.id} />
                    <button type="submit" className="tertiary-action">
                      revoke
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="stated-absence mt-5 text-[13px] leading-relaxed">
          A new token is emailed to you rather than shown here. Only a SHA-256 of it is stored, so it
          cannot be recovered — and a credential displayed on this screen would be one visible to
          whoever you are screen-sharing with while you configure the integration. If a token is lost,
          issue another and revoke the old one.
        </p>

        <form method="post" action="/api/enterprise/identity" className="mt-5">
          <input type="hidden" name="intent" value="scim_token" />
          <fieldset disabled={!view.allowed} className="border-0 p-0 disabled:opacity-55">
            <label className="block" htmlFor="label">
              <span className="section-label">what to call this token</span>
            </label>
            <input
              id="label"
              name="label"
              type="text"
              defaultValue="SCIM provisioning"
              className="goal-input"
              autoComplete="off"
            />
            <button type="submit" className="primary-action mt-6">
              Issue a token
            </button>
          </fieldset>
        </form>
      </section>

      <p className="mt-12 border-t border-t-[color:var(--rule)] pt-6">
        <a href="/seats" className="tertiary-action">
          ← seats
        </a>
      </p>

      <p className="stated-absence mt-4 text-[13px] leading-relaxed">
        SAML and SCIM are part of the {ENTERPRISE_PLAN_NAME} plan. Every other way of signing in works on
        every plan.
      </p>
    </main>
  );
}
