/**
 * The published legal and trust content, declared once.
 *
 * ## Why this is a module and not six MDX files
 *
 * Three of the acceptance criteria are about the *same sentence* appearing in two places and staying
 * the same: the Article 22 statement has to say alignment flags are advisory, the no-ranking stance has
 * to link the test that enforces it, and the subprocessor list has to be the list the 30-day notice job
 * compares against. Prose duplicated between `docs/` and a page drifts, and the drift is invisible —
 * both copies read correctly on their own.
 *
 * So the content is data. The pages render it, the notice job hashes it, and
 * `tests/legal-content.test.tsx` asserts the claims the criteria name are actually present. A lawyer
 * reviewing wording edits one array.
 *
 * ## What is deliberately *not* here
 *
 * `docs/legal/*.md` are the auto-generated pre-review drafts, full of `[BRACKETED]` placeholders. They
 * are kept as the lawyer's working copy and are **not** what the product serves — publishing a document
 * with `[DATE]` in it would be worse than publishing nothing. `docs/legal/README.md` says so and points
 * here.
 */

/** Every subprocessor, the data it receives and where it processes it. */
export interface Subprocessor {
  /** Stable key, so the notice job can diff two revisions of this list by identity. */
  readonly id: string;
  readonly name: string;
  /** What Compass uses them for, in one clause. */
  readonly purpose: string;
  /** The data category they receive. Named specifically — "usage data" is not a category. */
  readonly dataCategory: string;
  /** Processing region, as the provider states it. */
  readonly region: string;
  /**
   * True when a deployment can run with this subprocessor switched off.
   *
   * Compass's zero-config posture means most of these are optional, and saying so is part of the
   * disclosure: a self-hosted deployment with no Anthropic key sends nothing to a language model, and a
   * reader deciding whether to trust the product needs to know that is a real configuration rather than
   * a promise.
   */
  readonly optional: boolean;
}

/**
 * The list, and the single source the notice job diffs.
 *
 * Ordered by how much data each one sees, most first, because that is the order a reader cares about
 * rather than alphabetical.
 */
export const SUBPROCESSORS: readonly Subprocessor[] = Object.freeze([
  Object.freeze({
    id: 'cloud-host',
    name: 'Fly.io',
    purpose: 'Runs the web and worker processes and the managed PostgreSQL database.',
    dataCategory:
      'Everything Compass stores: accounts, the knowledge model, reports, and the ingested commits, ' +
      'pull requests, tickets and opted-in chat messages behind them.',
    region: 'London (lhr), United Kingdom',
    optional: false,
  }),
  Object.freeze({
    id: 'llm-provider',
    name: 'Anthropic',
    purpose:
      'Narrates an already-computed report into prose, and extracts Manager Memos into a closed ' +
      'five-kind schema. It never decides what a report says.',
    dataCategory:
      'The structured report payload only — figures, tracker keys, pull request numbers and, unless ' +
      'minimization is set to redacted or none, developer display names. Never a commit message, a ' +
      'pull request body, a ticket comment or a chat message.',
    region: 'United States',
    optional: true,
  }),
  Object.freeze({
    id: 'email-sender',
    name: 'Resend',
    purpose: 'Delivers the daily report, sign-in links, invitations and billing notices.',
    dataCategory:
      'Recipient email addresses and the rendered report body, which contains the same figures and ' +
      'identifiers the report page shows.',
    region: 'United States',
    optional: true,
  }),
  Object.freeze({
    id: 'error-tracker',
    name: 'Sentry',
    purpose: 'Receives an event when Compass throws, so a fault is fixed rather than guessed at.',
    dataCategory:
      'Stack traces and the organization id. Email addresses, credentials and raw ingested text are ' +
      'removed before an event leaves the process — see the scrubber in @compass/observability.',
    region: 'United States',
    optional: true,
  }),
  Object.freeze({
    id: 'payment-provider',
    name: 'Stripe',
    purpose: 'Takes payment and holds the subscription. Compass never sees a card number.',
    dataCategory:
      'The billing email address, the seat count and the plan. Card details go directly to Stripe and ' +
      'are never transmitted through Compass.',
    region: 'United States',
    optional: true,
  }),
  Object.freeze({
    id: 'code-host',
    name: 'GitHub',
    purpose:
      'Read only, and only the repositories an owner selected. Compass reads from it; it never writes.',
    dataCategory:
      'No Compass data is sent. Compass reads commits, pull requests, reviews, branch tips and release ' +
      'tags. Listed because the read is authorised with a credential an owner granted.',
    region: 'United States',
    optional: true,
  }),
]);

/** How much advance notice a subprocessor change gets. Quoted by the page and used by the job. */
export const SUBPROCESSOR_NOTICE_DAYS = 30;

/**
 * A stable digest of the published list.
 *
 * The notice job compares this against the last value it announced, so "the list changed" is decided by
 * the *content* rather than by somebody remembering to send an email. Built from the fields a customer
 * would care about — a copy-edit to `purpose` is a change worth announcing; reordering the array is not,
 * so the ids are sorted first.
 */
export const subprocessorDigest = (list: readonly Subprocessor[] = SUBPROCESSORS): string =>
  list
    .map((entry) => `${entry.id}|${entry.name}|${entry.dataCategory}|${entry.region}`)
    .slice()
    .sort()
    .join('\n');

/**
 * What changed between two digests, phrased for the notice email.
 *
 * ## Why the digest is line-structured rather than a hash
 *
 * A SHA would answer "did it change" and nothing else, and a notice that tells a data protection officer
 * "something changed, go and diff a web page" has not given them thirty days of anything useful. Because
 * the digest is one line per subprocessor, the *previous* digest stored on a subscriber's row is a
 * complete record of what they were last told — so the difference can be described without keeping a
 * second history table.
 *
 * Pure, and keyed on the subprocessor id, so a rename reads as a change to an existing entry rather than
 * as one removal and one unrelated addition.
 */
export function describeSubprocessorChanges(
  previousDigest: string | null,
  currentDigest: string,
): readonly string[] {
  const parse = (digest: string): ReadonlyMap<string, readonly string[]> => {
    const rows = new Map<string, readonly string[]>();
    for (const line of digest.split('\n')) {
      if (line.trim().length === 0) continue;
      const [id, ...rest] = line.split('|');
      if (id !== undefined) rows.set(id, rest);
    }
    return rows;
  };

  // No previous digest means this subscriber has never been told anything. That is not "everything is
  // new" — it is a row written before the first notice — so the caller decides; here it is no changes.
  if (previousDigest === null) return [];

  const before = parse(previousDigest);
  const after = parse(currentDigest);
  const changes: string[] = [];

  for (const [id, fields] of after) {
    const previous = before.get(id);
    const [name, category, region] = fields;
    if (previous === undefined) {
      changes.push(`Added: ${name ?? id} — ${category ?? 'purpose not stated'} (${region ?? 'region not stated'})`);
      continue;
    }
    if (previous.join('|') !== fields.join('|')) {
      const [wasName, , wasRegion] = previous;
      changes.push(
        `Changed: ${name ?? id} — now ${category ?? 'purpose not stated'} (${region ?? 'region not stated'})` +
          (wasName !== name ? `, previously named ${wasName ?? id}` : '') +
          (wasRegion !== region ? `, previously processed in ${wasRegion ?? 'an unstated region'}` : ''),
      );
    }
  }

  for (const [id, fields] of before) {
    if (after.has(id)) continue;
    changes.push(`Removed: ${fields[0] ?? id} — Compass no longer sends it any data.`);
  }

  // Sorted so two runs over the same pair of digests produce the same email, which is what makes the
  // notice job's test assert on content rather than on ordering luck.
  return changes.sort();
}

// ---------------------------------------------------------------------------
// Policy documents
// ---------------------------------------------------------------------------

export interface PolicySection {
  readonly heading: string;
  /** Paragraphs, in order. Rendered as prose — one measure, no panels. */
  readonly paragraphs: readonly string[];
  /** Optional bulleted list beneath the paragraphs. */
  readonly bullets?: readonly string[];
}

export interface PolicyDocument {
  readonly slug: string;
  readonly title: string;
  /** One sentence under the title, saying what the document is for. */
  readonly lede: string;
  /**
   * The date the content last changed, ISO. Hand-maintained on purpose: an automatic
   * "last updated: today" is the classic policy-page lie, because it moves when nothing changed.
   */
  readonly lastUpdated: string;
  readonly sections: readonly PolicySection[];
}

/**
 * The Article 22 position, which is the document with the most legal weight in this file.
 *
 * GDPR Article 22 gives a person the right not to be subject to a decision "based solely on automated
 * processing" that produces "legal effects concerning him or her or similarly significantly affects
 * him or her". Compass's position is that it produces no such decision, and the three sentences the
 * acceptance criterion names are load-bearing rather than reassurance: alignment flags are **advisory**,
 * **manager-correctable**, and **not routed to HR systems**.
 */
export const AUTOMATED_DECISIONS: PolicyDocument = Object.freeze({
  slug: 'automated-decisions',
  title: 'Automated decisions and GDPR Article 22',
  lede:
    'Compass produces no automated decision with legal or similarly significant effect. This page says ' +
    'what it does produce instead, and what it will never do with it.',
  lastUpdated: '2026-08-05',
  sections: Object.freeze([
    Object.freeze({
      heading: 'The position, stated plainly',
      paragraphs: Object.freeze([
        'Compass writes one prose report a morning about a team’s work. It does not decide pay, ' +
          'promotion, performance ratings, disciplinary action, hiring, termination, or access to ' +
          'anything. No output of Compass is, or is intended to be, a decision about a person.',
        'Because there is no automated decision, Article 22 is not engaged. Compass states this rather ' +
          'than relying on it silently, because a buyer’s data protection officer is entitled to a ' +
          'written position and because the design choices that make it true are ones a reader can check.',
      ]),
    }),
    Object.freeze({
      heading: 'Alignment flags are advisory, correctable, and never routed to HR systems',
      paragraphs: Object.freeze([
        'Compass compares the wording of work against the wording of the objectives an organization ' +
          'declared, and where the two do not match it says so. That verdict — an alignment flag — is ' +
          'the closest thing in the product to a judgement, so it is the one hedged hardest.',
      ]),
      bullets: Object.freeze([
        'Advisory. A flag is a sentence in a report a manager reads. It gates nothing, triggers nothing ' +
          'and is not an input to any other decision Compass makes.',
        'Manager-correctable. Every flag can be dismissed or corrected in one click, and the correction ' +
          'is recorded as the manager’s own authorship. A dismissed flag stays dismissed; Compass does ' +
          'not re-raise a verdict a human has overruled.',
        'Evidenced, never asserted. Each flag shows the literal matched text, the objective it was ' +
          'compared against and a confidence score. Work Compass could not attribute is phrased as a ' +
          'question — “3 commits could not be tied to a sprint objective” — never as an accusation.',
        'Never routed to HR systems. Compass has no integration with any HR, payroll, performance or ' +
          'identity-management system, and there is no export designed to feed one. It delivers to a ' +
          'report page, an email inbox and a Slack channel, and nowhere else.',
      ]),
    }),
    Object.freeze({
      heading: 'What Compass will not compute',
      paragraphs: Object.freeze([
        'Some outputs are absent by construction rather than by policy, because a policy is a promise ' +
          'and a construction is a guarantee. Compass produces no per-person score, no leaderboard, no ' +
          'productivity index and no comparison of one named developer against another. That is enforced ' +
          'in code by a guard that inspects every generated report and refuses to publish one containing ' +
          'a ranking-shaped field — see the no-individual-ranking stance for the guard and its test.',
      ]),
    }),
    Object.freeze({
      heading: 'Human oversight, and how to object',
      paragraphs: Object.freeze([
        'A manager reads the report and decides what to do. Compass has no authority to act on its own ' +
          'findings and no mechanism to do so. Recommendations are suggestions a person accepts or ' +
          'rejects, and the acceptance is recorded as theirs.',
        'Anybody named in a Compass report can see what it says about them, withdraw their name from ' +
          'future reports, export their data or have it deleted, without a manager’s approval and ' +
          'without asking anybody at Compass. Those controls are on the “What Compass says about you” ' +
          'page, reachable from the footer of every report.',
      ]),
    }),
  ]),
});

/**
 * The no-individual-ranking stance, published separately because it is the promise buyers ask about
 * most and the one with a mechanical enforcement to point at.
 */
export const NO_RANKING_STANCE: PolicyDocument = Object.freeze({
  slug: 'no-ranking',
  title: 'Compass does not rank individuals',
  lede:
    'No per-person score, no leaderboard, no productivity index, no comparison of one named developer ' +
    'against another — enforced by a guard in code, not by a promise on a page.',
  lastUpdated: '2026-08-05',
  sections: Object.freeze([
    Object.freeze({
      heading: 'Why a tool that reads everyone’s work refuses to rank them',
      paragraphs: Object.freeze([
        'Compass reads every commit, pull request and ticket a team produces. A product with that much ' +
          'visibility could trivially compute a per-person number, and the reason it does not is that ' +
          'the number would be wrong and would be used anyway. Commit counts measure how somebody ' +
          'commits. Lines changed measure verbosity. Tickets closed measure ticket size. Each is a proxy ' +
          'that punishes the person who did the hard, slow, unglamorous piece of work.',
        'So the report is about the *work*, not the workers. Sections name people only where naming them ' +
          'is the actionable fact — who to ask about a blocked ticket, whose review a change is waiting ' +
          'on — and never as a measurement of them.',
      ]),
    }),
    Object.freeze({
      heading: 'The guard, and the test that enforces it',
      paragraphs: Object.freeze([
        'Every generated report passes through `assertNoIndividualRanking` before it can be persisted or ' +
          'rendered. The guard walks the whole report object and refuses any field whose name matches a ' +
          'ranking shape — leaderboard, score, rating, rank, productivity index, percentile, ' +
          'contribution share — and it fails closed: a report containing one is not published at all.',
        'The guard lives in `packages/analysis/src/ranking-guard.ts` and is called from ' +
          '`packages/analysis/src/generate.ts`. It is exercised by ' +
          '`packages/analysis/tests/determinism.test.ts`, which runs it over every report in the seeded ' +
          'corpus, asserts a `leaderboard` field is rejected, and asserts that an artifact list which ' +
          'merely mentions people is not mistaken for a ranking. Those assertions are the enforcement; ' +
          'this page is only where they are written down.',
      ]),
      bullets: Object.freeze([
        'packages/analysis/src/ranking-guard.ts — the guard and the banned field patterns',
        'packages/analysis/src/generate.ts — where every report is checked before it exists',
        'packages/analysis/tests/determinism.test.ts — the test that proves it, over the real corpus',
      ]),
    }),
    Object.freeze({
      heading: 'What this does not promise',
      paragraphs: Object.freeze([
        'Compass cannot stop a manager reading a report and forming a view about a person; no software ' +
          'can, and claiming otherwise would be the dishonest version of this page. What it can do is ' +
          'refuse to hand anybody a number that makes such a view look objective, and refuse to build ' +
          'the export that would carry it into a performance system. Both refusals are structural.',
      ]),
    }),
  ]),
});

/**
 * The DPIA, completed rather than templated.
 *
 * A Data Protection Impact Assessment is required where processing is likely to result in a high risk
 * to people's rights — and "systematic monitoring of employees" is on every regulator's list of
 * triggers, so Compass publishes one rather than arguing it is exempt. The structure follows Article
 * 35(7): the processing, the necessity, the risks, and the measures.
 */
export const DPIA: PolicyDocument = Object.freeze({
  slug: 'dpia',
  title: 'Data Protection Impact Assessment',
  lede:
    'Compass reads the working records of an engineering team, which is systematic monitoring of ' +
    'employees. This is the assessment of that, published rather than filed.',
  lastUpdated: '2026-08-05',
  sections: Object.freeze([
    Object.freeze({
      heading: '1. The processing, described',
      paragraphs: Object.freeze([
        'Compass ingests, on a schedule, from sources an organization connects: commits, pull requests, ' +
          'reviews, branch tips and release tags from a code host; tickets, status transitions and sprint ' +
          'scope changes from a tracker; and messages from named chat channels an owner has explicitly ' +
          'opted in. It reconciles these into a versioned knowledge model, computes a structured report, ' +
          'and delivers one prose report a morning to the managers of one to three teams.',
        'The people whose data is processed are the engineers whose work is read, and the managers and ' +
          'other seat holders who read the reports. The lawful basis for the former is the controller’s ' +
          'legitimate interest in understanding the progress of work it commissioned; for the latter it ' +
          'is the performance of the contract under which they use the product. The controller is the ' +
          'customer organization; Compass is the processor.',
      ]),
    }),
    Object.freeze({
      heading: '2. Necessity and proportionality',
      paragraphs: Object.freeze([
        'The purpose is to tell a manager what happened, what matters and what to do next. Every field ' +
          'ingested is one a section of the report is computed from; there is no collection "in case it ' +
          'is useful later". Chat is the narrowest case and is therefore the most restricted: it is ' +
          'opt-in per named public channel, private conversations and direct messages cannot be enabled ' +
          'by any path including a database session, and three independent guards enforce that.',
        'Raw message bodies are retained for 90 days by default and derived reports for three years, ' +
          'both configurable by the controller. The defaults are the shortest windows that still let a ' +
          'manager investigate last quarter’s slip.',
      ]),
    }),
    Object.freeze({
      heading: '3. Risks to the people whose data is read',
      paragraphs: Object.freeze([
        'Four were identified, and they are stated as risks rather than as things already solved.',
      ]),
      bullets: Object.freeze([
        'Function creep into performance management. A tool that reads everyone’s work invites use as an ' +
          'appraisal input. This is the highest-likelihood risk and the reason for the Article 22 ' +
          'statement and the ranking guard.',
        'Misattribution. A commit under an unmatched email address could be attributed to the wrong ' +
          'person. Compass leaves unclaimed identifiers in a queue rather than guessing.',
        'Chilling effect from opaque monitoring. Being measured by a system whose reasoning is hidden ' +
          'changes behaviour. Compass’s answer is that every claim carries its receipt and every person ' +
          'can read what the product says about them.',
        'Disclosure to a language-model provider. Narration sends a payload off-premises. The payload is ' +
          'the structured report, never raw ingested text, and that is enforced by a build-time check.',
      ]),
    }),
    Object.freeze({
      heading: '4. Measures, and where each one is enforced',
      paragraphs: Object.freeze([
        'Each measure below is implemented rather than intended, and most are enforced by a test or a ' +
          'database constraint rather than by a convention.',
      ]),
      bullets: Object.freeze([
        'No individual ranking, enforced by a guard over every generated report and its test.',
        'No routing to HR systems: no such integration exists and no export is designed for one.',
        'Transparency to the data subject: a page showing everything Compass holds about the reader, ' +
          'reachable from the footer of every report by every seat.',
        'Withdrawal of a name: a pseudonym replaces it in future reports, and past reports render “a ' +
          'former team member” at read time without rewriting the stored rows.',
        'Correction: any finding can be dismissed or corrected, and the correction is recorded as the ' +
          'manager’s own act rather than as an edit to history.',
        'Data minimization to the model: no commit message, pull request body, ticket comment or chat ' +
          'message is ever sent to a language model, in any mode.',
        'Retention limits with a scheduled purge that records a row whether or not it deleted anything, ' +
          'so a dead scheduler is distinguishable from a quiet one.',
        'Deletion within 30 days of request, with a 7-day undo window and a confirmation enumerating ' +
          'what was deleted.',
        'Tenant isolation on every table, enforced by a scoped query layer and an isolation test.',
        'Credential encryption: OAuth tokens are sealed under a per-organization data key.',
      ]),
    }),
    Object.freeze({
      heading: '5. Outcome',
      paragraphs: Object.freeze([
        'The residual risk after these measures is assessed as low, on the basis that the highest-risk ' +
          'use — performance management — is structurally unavailable rather than merely discouraged, ' +
          'and that the people read by the product have direct, unmediated access to what it says about ' +
          'them. This assessment is reviewed when a new source is connected, when the narration payload ' +
          'changes shape, or annually, whichever is sooner.',
        'A controller who needs this as a countersigned document, or who needs the SBOM or a security ' +
          'questionnaire, can ask at the address on the data-processing page.',
      ]),
    }),
  ]),
});

/** The terms of service. Short, because a long one is a document nobody reads. */
export const TERMS: PolicyDocument = Object.freeze({
  slug: 'terms',
  title: 'Terms of service',
  lede: 'What Compass agrees to do, what you agree to, and how either side ends it.',
  lastUpdated: '2026-08-05',
  sections: Object.freeze([
    Object.freeze({
      heading: 'The service',
      paragraphs: Object.freeze([
        'Compass reads the engineering sources you connect and delivers one prose report a morning to ' +
          'the seats you invite. You keep every right in your data; Compass processes it on your ' +
          'instructions and for no other purpose. Compass does not train models on your data.',
      ]),
    }),
    Object.freeze({
      heading: 'Your account',
      paragraphs: Object.freeze([
        'You are responsible for who you invite and for what they do with their seat. Every seat that ' +
          'can sign in counts against your plan, including a pending invitation. You must have the ' +
          'authority to connect the sources you connect.',
      ]),
    }),
    Object.freeze({
      heading: 'Payment',
      paragraphs: Object.freeze([
        'Plans are per seat, per month, at the prices shown on the pricing page. A trial needs no card. ' +
          'A failed payment opens a grace period during which Compass keeps working and tells you the ' +
          'deadline; after it, report generation and delivery stop and your history stays readable and ' +
          'exportable. Cancelling keeps the service running to the end of the period already paid for.',
      ]),
    }),
    Object.freeze({
      heading: 'What Compass does not promise',
      paragraphs: Object.freeze([
        'Compass computes findings from the data your sources give it. Where the data is thin, missing ' +
          'or contradictory, Compass says so in the report rather than guessing — but it cannot be more ' +
          'accurate than its sources. Nothing Compass produces is a decision about a person, and nothing ' +
          'in it should be used as one; see the Article 22 statement.',
        'The service is provided as-is to the extent the law allows. Compass’s liability is limited to ' +
          'the fees you paid in the twelve months before the claim.',
      ]),
    }),
    Object.freeze({
      heading: 'Ending it',
      paragraphs: Object.freeze([
        'You can cancel or delete your organization at any time, from inside the product, without ' +
          'asking anybody. Deletion is irreversible after a 7-day undo window. Compass may end an ' +
          'account that is being used to break the law or to attack the service, with notice where ' +
          'notice is possible.',
      ]),
    }),
  ]),
});

/** The privacy policy. The in-product companion to the transparency screen at `/privacy`. */
export const PRIVACY_POLICY: PolicyDocument = Object.freeze({
  slug: 'privacy',
  title: 'Privacy policy',
  lede: 'What Compass holds, why, who else sees it, and what you can do about all three.',
  lastUpdated: '2026-08-06',
  sections: Object.freeze([
    Object.freeze({
      heading: 'What Compass holds',
      paragraphs: Object.freeze([
        'Two kinds of data, and the distinction matters. **Account data** is the people who sign in: an ' +
          'email address, a display name, a password hash or a linked identity, and the seat’s role. ' +
          '**Work data** is what your sources report: commits, pull requests, reviews, branch tips, ' +
          'release tags, tickets, status transitions, sprint scope changes, and messages from chat ' +
          'channels you explicitly opted in.',
        'Compass also stores what it computed from that — the knowledge model, the reports, and the ' +
          'corrections and dismissals managers made — plus an audit log of who changed what.',
      ]),
    }),
    Object.freeze({
      heading: 'Why',
      paragraphs: Object.freeze([
        'To compute and deliver the daily report, and for nothing else. There is no advertising, no ' +
          'profiling for any purpose beyond the report, no sale of data to anybody, and no model ' +
          'training on your content.',
      ]),
    }),
    Object.freeze({
      heading: 'Who else sees it',
      paragraphs: Object.freeze([
        'The subprocessors named on the data-processing page, each receiving only the category listed ' +
          'there. Most are optional: a deployment with no language-model key sends nothing to one, and a ' +
          'deployment with no mail key delivers nothing by email.',
      ]),
    }),
    Object.freeze({
      heading: 'How long',
      paragraphs: Object.freeze([
        'Raw chat message bodies for 90 days by default, derived data and reports for three years, both ' +
          'settable by an owner. A scheduled purge enforces the windows and records each run whether or ' +
          'not it deleted anything.',
      ]),
    }),
    Object.freeze({
      /**
       * The cookie disclosure, and the reason there is no consent banner.
       *
       * ePrivacy Article 5(3) requires *information* about anything stored on a device, and exempts
       * from *consent* only what is strictly necessary to provide the service the person asked for.
       * Compass sets two cookies and both are in that class, so the honest surface is this section
       * rather than a banner. A banner asking permission for cookies that do not need it would be
       * theatre: its "reject" button could not reject anything without signing the reader out, and
       * offering a choice that cannot be honoured teaches people the choice is meaningless.
       *
       * This stays true only while the inventory does. `legal-content.test.ts` reads the cookie
       * names out of `apps/web/lib/auth/cookies.ts` and fails if one is set that this section does
       * not name — so adding a third cookie forces a decision here rather than slipping past.
       */
      heading: 'What Compass stores in your browser',
      paragraphs: Object.freeze([
        'Two cookies, both strictly necessary, both `HttpOnly` — meaning no script on the page can ' +
          'read either of them — and both `SameSite=Lax` and `Secure` wherever the connection is ' +
          'HTTPS. Compass sets nothing else: no `localStorage`, no analytics or advertising cookie, ' +
          'no third-party script, no tracking pixel, and no fingerprinting. The Content-Security-' +
          'Policy would block a third-party script even if one were added by mistake.',
        'There is deliberately **no cookie-consent banner**, and that is a position rather than an ' +
          'omission. Consent is required for cookies that are not strictly necessary, and Compass ' +
          'sets none of those. A banner would ask permission for something that needs none, and its ' +
          '“reject” option could not reject the session cookie without signing you out — a choice ' +
          'that cannot be honoured is worse than no choice. Refusing both cookies in your browser is ' +
          'still available and still works; you will not be able to sign in, which is what refusing ' +
          'a sign-in cookie means.',
        'Error reports are a separate question and worth stating plainly here rather than leaving to ' +
          'the subprocessor list: they are generated **on the server**, never in your browser, so ' +
          'nothing about them depends on a device choice. Stack traces pass through a scrubber that ' +
          'removes addresses, credentials and ingested text before an event leaves the process, and a ' +
          'deployment with no error-tracking key sends none at all.',
      ]),
      bullets: Object.freeze([
        '`compass_session` — proves you are signed in. It holds a random secret; the database keeps ' +
          'only a hash of it. Expires 30 days after it is issued, and sooner if you are idle, sign ' +
          'out, or an owner changes your role.',
        '`compass_sso_nonce` — set only if you sign in through an identity provider, and only for the ' +
          'ten minutes that round trip lasts. It ties the provider’s answer to the browser that ' +
          'started the request, which is what stops somebody feeding you their own sign-in. Cleared ' +
          'the moment the round trip finishes, whatever the outcome.',
      ]),
    }),
    Object.freeze({
      heading: 'What you can do',
      paragraphs: Object.freeze([
        'Every one of these is self-serve, from inside the product, with no approval from a manager and ' +
          'no request to Compass.',
      ]),
      bullets: Object.freeze([
        'See everything Compass holds about you, on the “What Compass says about you” page.',
        'Withdraw your name from future reports, keeping every figure and receipt intact.',
        'Export your data.',
        'Delete your account, or — as an owner — the whole organization, with a 7-day undo window.',
        'Turn off narration entirely, so nothing is sent to a language model.',
      ]),
    }),
    Object.freeze({
      heading: 'Automated decisions',
      paragraphs: Object.freeze([
        'Compass makes none with legal or similarly significant effect. The Article 22 statement sets ' +
          'out the position in full, including that alignment flags are advisory, manager-correctable ' +
          'and never routed to HR systems.',
      ]),
    }),
  ]),
});

/** Every published policy document, for the index and for the route enumeration test. */
export const POLICY_DOCUMENTS: readonly PolicyDocument[] = Object.freeze([
  TERMS,
  PRIVACY_POLICY,
  DPIA,
  AUTOMATED_DECISIONS,
  NO_RANKING_STANCE,
]);

/** Where a controller asks for the SBOM, a countersigned DPIA or a security questionnaire. */
export const TRUST_CONTACT = 'trust@compass.example';
