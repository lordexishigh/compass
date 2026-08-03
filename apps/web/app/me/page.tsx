import { formatCivilDate, formatCivilDateTime } from '@compass/clock';
import { headers } from 'next/headers';

import { StatedFailure } from '../../components/stated-failure';
import { pageAccess } from '../../lib/auth/guard';
import { loadAboutMe, type AboutMeView } from '../../lib/privacy-source';

/**
 * `/me` — what Compass says about you.
 *
 * ## The screen this product needs most
 *
 * "It reads as surveillance" is a listed reason managers abandon a tool like this, and the
 * feeling does not come from Compass reading a repository — it comes from a colleague being
 * unable to find out what it said. So this page exists, it needs no approval, and a member
 * reaching it does not have to ask anybody: the answer is computed from their own session.
 *
 * ## What is deliberately not here
 *
 * No ranking. No comparison to a colleague. No score, no percentile, no trend line about the
 * reader. Every mention is quoted verbatim from a stored report, so the page cannot say
 * anything about somebody that their manager was not already told — and it cannot invent a
 * judgement of its own. A page that said "7th of 9 on review latency" would be exactly the
 * product this task exists to avoid building, and it would be the last page anybody trusted.
 *
 * ## Set as a document, like everything else
 *
 * One measure, plain sections, top to bottom. Not a dashboard of tiles: somebody opening this
 * is asking a question about themselves and reading the answer, which is prose.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'What Compass says about you — Compass',
};

function Frame({
  heading,
  lede,
  children,
}: {
  readonly heading: string;
  readonly lede?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[52rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">about you</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
        {lede}
      </header>
      {children}
    </div>
  );
}

/** A section heading in the report's own idiom: a label, a rule, a measure of prose. */
function Section({
  numeral,
  title,
  children,
}: {
  readonly numeral: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="mt-12">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[11px] tabular-nums text-ink-faint">{numeral}</span>
        <h2 className="text-[15px] font-semibold tracking-tight text-ink-strong">{title}</h2>
      </div>
      <div className="hairline mt-2" />
      {children}
    </section>
  );
}

function StoredFields({ view }: { readonly view: AboutMeView }) {
  return (
    <dl className="mt-5 space-y-4">
      {view.fields.map((field) => (
        <div key={field.label} className="grid gap-1 sm:grid-cols-[13rem_1fr] sm:gap-4">
          <dt className="text-[13px] text-ink-muted">{field.label}</dt>
          <dd className="text-[14px] text-ink-strong">
            <span className="data-token">{field.value}</span>
            <span className="mt-0.5 block font-serif text-[12.5px] italic text-ink-faint">from {field.source}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default async function AboutMePage() {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/me', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <Frame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} Nothing about you has changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  if (!access.allowed || access.identity === null) {
    return (
      <Frame heading="Sign in to see what Compass holds about you">
        {/* The same sentence the matrix gives every other refusal, from the same matrix. This
            page needs a session not as a gate but because the answer *is* the session: there
            is no question an anonymous reader could be asking it. */}
        <StatedFailure
          detail={
            access.reason ??
            'This page answers a question about you, so Compass has to know who you are before it can answer it. ' +
              'No manager approval is needed once you have a seat — only a session.'
          }
        >
          <a href="/account" className="tertiary-action">
            sign in
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  let view: AboutMeView | null = null;
  let unreadable: string | null = null;
  try {
    view = await loadAboutMe(access.scoped, access.identity, access.now);
  } catch (error) {
    unreadable = error instanceof Error ? error.message : 'Compass could not assemble the answer.';
  }

  if (view === null) {
    return (
      <Frame heading="Compass could not assemble the answer">
        <StatedFailure detail={`${unreadable} Nothing about you has changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  const mode = view.llmMinimizationMode;

  return (
    <Frame
      heading={`What Compass says about ${view.displayName}`}
      lede={
        <>
          <p className="prose-narration mt-3">
            Everything below is what Compass holds about you and every line in a stored report that names you, quoted as
            written. Nobody had to approve your seeing it and nobody is told that you looked.
          </p>
          <p className="prose-narration mt-3">
            There is no ranking on this page, no comparison to a colleague and no score. Compass computes findings about{' '}
            <em>work</em> — a ticket that has not moved, a review nobody has picked up — and names whoever the roster
            says the work belongs to. It does not rate people, and this page is not a report card.
          </p>
          <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
            <a href="/" className="tertiary-action">
              ← today&apos;s report
            </a>
            <a href="/account" className="tertiary-action">
              your account
            </a>
          </p>
        </>
      }
    >
      <Section numeral="01" title="What Compass stores about you">
        <StoredFields view={view} />

        {view.matched ? null : (
          <p className="stated-absence mt-5">
            Compass has not connected your account to anybody on the roster, so it holds nothing about your{' '}
            <em>work</em> — only the account details above. That usually means the email address on your seat is not one
            of the addresses your commits and tickets carry. An owner or manager can link it on the roster screen, and
            until they do, no report line can name you.
          </p>
        )}
      </Section>

      <Section numeral="02" title="The identifiers your work arrives under">
        {view.identifiers.length === 0 ? (
          <p className="stated-absence mt-5">
            No identifiers are linked to you. Compass never guesses that an address belongs to a person, so work under
            an unlinked address is reported as unattributed rather than credited to a name it inferred.
          </p>
        ) : (
          <ul className="mt-5 space-y-2">
            {view.identifiers.map((identifier) => (
              <li key={`${identifier.kind}:${identifier.value}`} className="text-[14px] text-ink">
                <span className="font-mono text-[12px] text-ink-faint">{identifier.kind}</span>{' '}
                <span className="data-token">{identifier.value}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section numeral="03" title="Every report line that names you">
        {view.mentions.length === 0 ? (
          <p className="stated-absence mt-5">
            No stored report names you. That is a statement about the reports Compass has written, not a judgement about
            your work: most findings are about an item rather than a person, and a great deal of work never produces one.
          </p>
        ) : (
          <>
            <p className="prose-narration mt-4">
              <span className="data-token">{view.mentions.length}</span>{' '}
              {view.mentions.length === 1 ? 'line' : 'lines'} across the stored archive. Each is quoted exactly as the
              report says it, with a link to the report it is in.
            </p>
            <ul className="mt-5 space-y-6">
              {view.mentions.map((mention, index) => (
                <li key={`${mention.reportId}:${index}`}>
                  <p className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                    {mention.reportDate} · {mention.scopeLabel} · {mention.sectionTitle}
                  </p>
                  <p className="prose-narration mt-1">{mention.line}</p>
                  <a href={`/archive/${mention.reportId}`} className="tertiary-action mt-1 inline-block">
                    read that report
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section numeral="04" title="Chat Compass has read that you wrote">
        <p className="prose-narration mt-4">
          Compass reads only the channels somebody has explicitly named, never a direct message and never a private
          channel. Messages are deleted after <span className="data-token">{view.rawRetentionDays} days</span>.
        </p>
        {view.chatMessagesHeld.length === 0 ? (
          <p className="stated-absence mt-4">
            Compass is holding none of your messages. Either no channel is enabled for reading, or none of the messages
            in the enabled channels arrived under an identifier linked to you.
          </p>
        ) : (
          <ul className="mt-5 space-y-4">
            {view.chatMessagesHeld.map((message) => (
              <li key={message.id}>
                <p className="font-mono text-[11px] text-ink-faint">
                  #{message.conversationName} · {formatCivilDateTime(message.occurredAt, 'UTC')}
                </p>
                <p className="prose-narration mt-1">{message.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section numeral="05" title="What leaves this machine">
        <p className="prose-narration mt-4">
          {mode === 'none'
            ? 'Nothing. Your organization has narration turned off, so every report is written by Compass’s own template renderer and no part of it is sent to a language model.'
            : mode === 'redacted'
              ? 'The wording, and never a name. Compass computes the whole report here, then asks a language model to word the result — and in redacted mode every name in that request is replaced by a stable pseudonym, with the real names substituted back on this machine afterwards. The model is never told who works here.'
              : 'The wording. Compass computes the whole report here, then asks a language model to word the already-computed result. Names travel in that request. Your organization can switch to redacted mode, which sends pseudonyms instead and produces the same page.'}
        </p>
        <p className="prose-narration mt-3">
          In every mode, raw text never travels: no commit message, no pull request body, no ticket comment and no chat
          message is ever included in a request to a model. That is enforced structurally rather than by care — the
          build fails if a field carrying raw text is added to what the model is shown.
        </p>
      </Section>

      <Section numeral="06" title="If you want your name out of this">
        <p className="prose-narration mt-4">
          {view.anonymized
            ? 'Your name has already been withdrawn. Reports written from now on use a stable pseudonym in place of it, and reports already written render “a former team member” where the name was, keeping every ticket key, pull request number and count intact.'
            : 'Ask an owner or a manager to anonymise you. From then on, reports use a stable pseudonym in place of your name, and reports already written render “a former team member” where the name was — the ticket keys, pull request numbers and counts stay, because they are the record of work that happened.'}
        </p>
        <p className="prose-narration mt-3">
          You can also delete your account outright, which removes your seat, your sessions and your subscriptions. It
          does not remove the tickets and pull requests attributed to you: those are the team&apos;s record of work,
          and deleting them would take a day out of somebody else&apos;s history. Anonymization is the instrument for
          the name.
        </p>
        <p className="mt-5 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/account" className="tertiary-action">
            delete your account
          </a>
        </p>
      </Section>

      <p className="mt-14 font-serif text-[12.5px] italic text-ink-faint">
        Assembled {formatCivilDate(access.now, 'UTC')} from this organization&apos;s own records.
      </p>
    </Frame>
  );
}
