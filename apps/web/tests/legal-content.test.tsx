// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { isPublicRoute, ROLE_MATRIX } from '@compass/auth';
import {
  AUTOMATED_DECISIONS,
  DPIA,
  NO_RANKING_STANCE,
  POLICY_DOCUMENTS,
  SUBPROCESSORS,
  SUBPROCESSOR_NOTICE_DAYS,
  TRUST_CONTACT,
} from '@compass/trust';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import AcceptInvitePage from '../app/account/invite/page';
import LegalIndexPage from '../app/legal/page';
import LegalDocumentPage from '../app/legal/[slug]/page';
import SubprocessorsPage from '../app/trust/subprocessors/page';
import { PolicyBody } from '../components/policy-document';

/**
 * The published legal surfaces, rendered.
 *
 * `packages/trust/tests/content.test.ts` proves the *content* — that the Article 22 statement makes its
 * four claims, that the no-ranking stance names a guard that still exists. This file proves the half that
 * only exists once the components run, which is where the acceptance criteria actually live:
 *
 *  - "the data-processing page names every subprocessor with data category and region";
 *  - "with a subscribe control for 30-day advance notice of changes";
 *  - "reachable without an account" — the criterion the route matrix decides, not the component;
 *  - "the DPIA and the Article 22 statement are published and linked from the privacy page".
 *
 * A correct constant rendered by nothing satisfies none of them. Every assertion below is derived from
 * `@compass/trust` rather than written as a literal, so a subprocessor added to the module is a subprocessor
 * this suite immediately demands the page display.
 */

/** `notFound()` throws in Next; this makes the throw observable without a router. */
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

/** Markup to text: tags out, entities in, so a `&rsquo;` does not break a `toContain`. */
const textOf = (markup: string): string => {
  const element = document.createElement('div');
  element.innerHTML = markup;
  return element.textContent ?? '';
};

const renderSubprocessors = () => renderToStaticMarkup(<SubprocessorsPage />);

/** Awaits the dynamic document page for one slug. */
const renderDocument = async (slug: string): Promise<string> =>
  renderToStaticMarkup(await LegalDocumentPage({ params: Promise.resolve({ slug }) }));

describe('the data-processing page discloses every subprocessor at the promised granularity', () => {
  it('names every subprocessor, its data category and its region', () => {
    const markup = renderSubprocessors();
    const text = textOf(markup);

    // Derived from the module, so this cannot pass by having been written once against six known rows.
    expect(SUBPROCESSORS.length).toBeGreaterThan(0);

    for (const entry of SUBPROCESSORS) {
      expect(text, `${entry.id} is not named on /trust/subprocessors`).toContain(entry.name);
      expect(text, `${entry.id}'s data category is not disclosed`).toContain(entry.dataCategory);
      expect(text, `${entry.id}'s processing region is not disclosed`).toContain(entry.region);
      expect(text, `${entry.id}'s purpose is not stated`).toContain(entry.purpose);
      // One row per subprocessor, addressable by id — the attribute the notice job's page-side counterpart
      // would key on, and what makes "every one is rendered" checkable rather than a substring accident.
      expect(markup).toContain(`data-subprocessor="${entry.id}"`);
    }

    const rows = markup.match(/data-testid="subprocessor-row"/g) ?? [];
    expect(rows).toHaveLength(SUBPROCESSORS.length);
  });

  it('says which subprocessors are optional rather than implying all are required', () => {
    const text = textOf(renderSubprocessors());

    // "We may share your data with service providers" is the disclosure this page exists to refuse. A
    // reader deciding whether to trust the product needs to know that switching one off is a real
    // configuration.
    expect(text).toContain('optional');
    expect(text).toContain('required');
    expect(SUBPROCESSORS.some((entry) => entry.optional)).toBe(true);
    expect(SUBPROCESSORS.some((entry) => !entry.optional)).toBe(true);
  });

  it('offers a no-JavaScript subscribe control posting to the notice endpoint', () => {
    const markup = renderSubprocessors();

    /**
     * A real `<form method="post">`.
     *
     * The people this control is for arrive without an account and often without JavaScript enabled — a
     * data protection officer opening a link from a procurement thread. A control that needed a client
     * bundle to submit would be a 30-day notice commitment that some readers cannot opt into.
     */
    expect(markup).toContain('action="/api/trust/subprocessor-notices"');
    expect(markup).toContain('method="post"');
    expect(markup).toContain('name="email"');
    expect(markup).toContain('type="email"');
    // Labelled, because this is a public page and the accessibility gate applies to it too.
    expect(markup).toContain('for="notice-email"');
    expect(markup).toContain('id="notice-email"');
  });

  it('states the notice window from the module, not as a literal in JSX', () => {
    const text = textOf(renderSubprocessors());

    // The number the worker's job computes the effective date from is the number the page promises.
    expect(text).toContain(`${SUBPROCESSOR_NOTICE_DAYS} days`);
    expect(text).toContain('advance notice');
    // And says the subscription needs no account, which is the point of it being public.
    expect(text).toContain('without having an account');
  });

  it('tells a reader they can unsubscribe before any notice is ever sent', () => {
    // Otherwise the control is a commitment to receive mail with no stated way out, on a public endpoint.
    expect(textOf(renderSubprocessors())).toContain('unsubscribe');
  });

  it('points at where to ask for what is not published', () => {
    expect(textOf(renderSubprocessors())).toContain(TRUST_CONTACT);
  });
});

describe('the five documents are published and reachable', () => {
  it('renders every document from its slug, with its sections', async () => {
    for (const document of POLICY_DOCUMENTS) {
      const text = textOf(await renderDocument(document.slug));

      expect(text, `${document.slug} does not render its title`).toContain(document.title);
      expect(text, `${document.slug} does not render its lede`).toContain(document.lede);
      expect(text, `${document.slug} does not state when it last changed`).toContain(document.lastUpdated);

      for (const section of document.sections) {
        expect(text, `${document.slug} is missing the "${section.heading}" section`).toContain(section.heading);
      }
    }
  });

  it('404s an unknown slug rather than rendering an empty document', async () => {
    // A legal URL that renders a blank page is worse than one that does not resolve: a reader cannot tell
    // whether the document is empty or whether they are on the wrong page.
    await expect(renderDocument('not-a-document')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('lists every document on the index, linked by slug', () => {
    const markup = renderToStaticMarkup(<LegalIndexPage />);
    const text = textOf(markup);

    for (const document of POLICY_DOCUMENTS) {
      expect(markup, `/legal does not link to ${document.slug}`).toContain(`href="/legal/${document.slug}"`);
      expect(text, `/legal does not name ${document.slug}`).toContain(document.title);
    }
    // And the subprocessor page, which is the one trust surface that is not a policy document.
    expect(markup).toContain('href="/trust/subprocessors"');
  });

  it('publishes the DPIA and the Article 22 statement in full, not as summaries', async () => {
    // The criterion is "published", and a page that said "a DPIA has been completed; contact us for a copy"
    // would render, link and satisfy nothing.
    const dpia = textOf(await renderDocument(DPIA.slug));
    for (const section of DPIA.sections) {
      for (const paragraph of section.paragraphs) {
        expect(dpia, `the DPIA omits a paragraph of "${section.heading}"`).toContain(paragraph);
      }
    }

    const article22 = textOf(await renderDocument(AUTOMATED_DECISIONS.slug));
    // The four hedges, rendered — asserted in the content suite as data, here as published words.
    for (const claim of ['Advisory.', 'Manager-correctable.', 'Evidenced, never asserted.', 'Never routed to HR systems.']) {
      expect(article22, `the rendered Article 22 statement no longer says "${claim}"`).toContain(claim);
    }
  });

  it('renders the no-ranking stance with the enforcing test named on the page', async () => {
    const text = textOf(await renderDocument(NO_RANKING_STANCE.slug));

    // The stance's claim is that a guard enforces it. Naming the test on the published page is what makes
    // that checkable by a reader rather than a thing they take on trust.
    expect(text).toContain('packages/analysis/tests/determinism.test.ts');
    expect(text).toContain('assertNoIndividualRanking');
  });
});

describe('terms and privacy are linked from the sign-up flow, not only the footer', () => {
  it('links both from the invitation page, where the account is created', async () => {
    /**
     * The criterion says "linked from the footer and the sign-up flow", and those are two different
     * readers. The report footer serves people who already have an account; accepting a seat is the moment
     * somebody agrees to something, and a policy linked only from a page you reach *after* agreeing is
     * documentation rather than consent.
     */
    const markup = renderToStaticMarkup(
      await AcceptInvitePage({ searchParams: Promise.resolve({ token: 'a-token' }) }),
    );

    expect(markup).toContain('href="/legal/terms"');
    expect(markup).toContain('href="/legal/privacy"');
    // And the Article 22 position, which is the document about the person taking the seat rather than
    // about the contract — the one a subject of a report has the most standing to read.
    expect(markup).toContain('href="/legal/automated-decisions"');
    expect(textOf(markup)).toContain('terms of service');
  });

  it('links them even when the invitation token is missing', async () => {
    // The page has two branches. A reader who arrives with a truncated link still gets the documents,
    // because "what am I being asked to agree to" does not depend on the token being intact.
    const markup = renderToStaticMarkup(await AcceptInvitePage({ searchParams: Promise.resolve({}) }));

    expect(markup).toContain('href="/legal/terms"');
    expect(markup).toContain('href="/legal/privacy"');
  });

  it('links both from the report footer as well', () => {
    // The other half of the same criterion. Asserted against the component that renders every report, so
    // it holds for the merged and weekly reads too rather than for one page.
    const source = readFileSync(join(import.meta.dirname, '..', 'components', 'report-document.tsx'), 'utf8');
    expect(source).toContain('href="/legal/terms"');
    expect(source).toContain('href="/legal/privacy"');
  });
});

describe('every /legal link in the app names a document that exists', () => {
  /**
   * The guarantee `generateStaticParams` used to give, moved to where it can still be given.
   *
   * `/legal/[slug]` was prerendered from an enumeration of `POLICY_DOCUMENTS`, so a typo in a link
   * failed the build. That enumeration had to go: the CSP is nonce-based, a nonce exists only per
   * response, and a prerendered page's scripts carry none — so every prerendered route loaded with
   * its whole client bundle refused by `'strict-dynamic'`. See the note in `app/legal/[slug]/page.tsx`.
   *
   * The check it provided does not have to go with it. Every `/legal/<slug>` written anywhere in the
   * app's own source is collected here and resolved against the closed list, so a mistyped document
   * link is still a red build — just a failing assertion rather than a failing prerender. The walk is
   * over the source rather than over rendered markup because several of these links live on pages that
   * need a database to render, and a typo must not depend on a test being able to reach one.
   */
  const slugs = new Set(POLICY_DOCUMENTS.map((document) => document.slug));

  const linkedSlugs = (): readonly { readonly file: string; readonly slug: string }[] => {
    const root = join(import.meta.dirname, '..');
    const found: { file: string; slug: string }[] = [];

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          // `tests` is excluded so this file's own examples of a bad slug do not count as links.
          if (entry.name !== 'node_modules' && entry.name !== '.next' && entry.name !== 'tests') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.ts')) continue;

        const source = readFileSync(full, 'utf8');
        for (const match of source.matchAll(/["'`]\/legal\/([a-z0-9-]+)/g)) {
          found.push({ file: relative(root, full), slug: match[1]! });
        }
      }
    };

    walk(root);
    return found;
  };

  const LINKS = linkedSlugs();

  it('found the links, so an empty walk cannot pass this test', () => {
    // The report footer, the invitation page and the subprocessor page each carry at least one.
    expect(LINKS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(LINKS.map((link) => link.file)).size).toBeGreaterThan(2);
  });

  it.each(LINKS.map((link) => [`${link.file} → /legal/${link.slug}`, link] as const))(
    '%s resolves to a published document',
    (_label, link) => {
      expect(
        slugs.has(link.slug),
        `${link.file} links to /legal/${link.slug}, which is not in POLICY_DOCUMENTS — that URL 404s`,
      ).toBe(true);
    },
  );
});

describe('the trust surfaces are reachable without an account', () => {
  const publicRoutes = new Set(ROLE_MATRIX.filter(isPublicRoute).map((rule) => rule.route));

  it.each([
    '/legal',
    '/legal/[slug]',
    '/trust/subprocessors',
    '/api/trust/subprocessor-notices',
    '/api/trust/subprocessor-notices/confirm',
  ])('%s is public in ROLE_MATRIX', (route) => {
    /**
     * The criterion the component cannot satisfy.
     *
     * New routes default to authenticated: unless a route is in the matrix as `public`, the subprocessor
     * page is not reachable without an account — and the people these documents are written for are
     * precisely the people who do not have one. A perfectly rendered terms page behind a session is not a
     * published terms page.
     */
    expect(publicRoutes.has(route), `${route} is not public, so nobody without an account can read it`).toBe(true);
  });

  it('grants those routes in every tenant, not only the seeded demonstration one', () => {
    // `demoOnlyPublic` confines a grant to the demo tenant. That is right for a sample report and wrong for
    // a legal document: a real customer's data protection officer must be able to read the DPIA.
    for (const route of ['/legal', '/legal/[slug]', '/trust/subprocessors']) {
      const rule = ROLE_MATRIX.find((candidate) => candidate.route === route);
      expect(rule, `${route} has no matrix entry`).toBeDefined();
      expect(
        (rule as { readonly demoOnlyPublic?: boolean }).demoOnlyPublic ?? false,
        `${route} is demo-only, so it is unreadable in a real tenant`,
      ).toBe(false);
    }
  });
});

/**
 * The cookie disclosure, held to the cookies the app actually sets.
 *
 * ePrivacy Article 5(3) requires information about anything stored on a reader's device, and exempts
 * from *consent* only what is strictly necessary. Compass sets two strictly-necessary cookies, so the
 * published surface is a section of the privacy policy rather than a banner — and that position is
 * only defensible while the section is complete.
 *
 * So this does not check that some prose about cookies exists. It reads the cookie names out of
 * `lib/auth/cookies.ts` and requires the policy to name each one. A third cookie added to the app
 * fails here, which forces the question "is this one strictly necessary?" to be answered by a person
 * at the moment it stops being hypothetical, rather than discovered in an audit.
 */
describe('the privacy policy discloses every cookie the app sets', () => {
  const COOKIE_SOURCE = readFileSync(join(process.cwd(), 'lib', 'auth', 'cookies.ts'), 'utf8');

  /** Every `_COOKIE_NAME = '…'` constant in the cookie module — the real inventory. */
  const cookieNames = [...COOKIE_SOURCE.matchAll(/COOKIE_NAME\s*=\s*'([^']+)'/g)].map((match) => match[1]!);

  const privacyPolicy = POLICY_DOCUMENTS.find((document) => document.slug === 'privacy')!;
  const browserSection = privacyPolicy.sections.find((section) => /browser/i.test(section.heading));
  const sectionText = [
    browserSection?.heading ?? '',
    ...(browserSection?.paragraphs ?? []),
    ...(browserSection?.bullets ?? []),
  ].join('\n');

  it('found cookies to check, so an empty inventory cannot pass', () => {
    // Two today. Asserted as a floor rather than an exact count: a third cookie should fail the
    // naming test below with a useful message, not this one with a confusing one.
    expect(cookieNames.length, 'no cookie constants were found — did the module move?').toBeGreaterThanOrEqual(2);
    expect(cookieNames).toContain('compass_session');
  });

  it('has a section about browser storage at all', () => {
    expect(browserSection, 'the privacy policy says nothing about what the browser stores').toBeDefined();
  });

  it.each(cookieNames.map((name) => [name]))('names %s and says what it is for', (name) => {
    expect(sectionText, `${name} is set by the app but the privacy policy does not disclose it`).toContain(name);
  });

  it('states the consent position rather than leaving the absent banner unexplained', () => {
    // The reader has to be told *why* there is no banner, or the absence reads as an oversight —
    // and a reviewer cannot tell the two apart either.
    expect(sectionText).toContain('strictly necessary');
    expect(sectionText.toLowerCase()).toContain('no cookie-consent banner');
  });

  it('claims no analytics, and is telling the truth about the client bundle', () => {
    expect(sectionText).toContain('localStorage');

    /**
     * The claim checked against the code, not just asserted in prose. A policy promising no
     * client-side storage while a component quietly writes one would be the worst outcome here —
     * worse than no policy, because it is a published falsehood.
     */
    const clientFiles: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '.next') walk(full);
          continue;
        }
        if (/\.tsx?$/.test(entry.name)) clientFiles.push(full);
      }
    };
    walk(join(process.cwd(), 'components'));
    walk(join(process.cwd(), 'app'));

    const offenders = clientFiles.filter((file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(code);
    });

    expect(
      offenders.map((file) => relative(process.cwd(), file)),
      'the privacy policy promises no browser storage beyond two cookies, and these files write some',
    ).toEqual([]);
  });
});

/**
 * The published documents render their markup rather than showing it.
 *
 * The content module is written in this codebase's own idiom — `**bold**` for a distinction,
 * backticks for an identifier — and for a while only the first of those was understood, so the
 * no-ranking stance published the sentence "passes through \`assertNoIndividualRanking\`" with the
 * punctuation visible. Nobody noticed because the assertions all matched on the raw constant, which
 * of course still contained the backticks.
 *
 * So these assert on the *rendered* markup: the delimiters are gone from the text, and the thing
 * between them became an element.
 */
describe('policy markup is rendered, not printed', () => {
  const renderDocument = (slug: string): string => {
    const document = POLICY_DOCUMENTS.find((candidate) => candidate.slug === slug)!;
    return renderToStaticMarkup(<PolicyBody document={document} />);
  };

  const documentsWithBackticks = POLICY_DOCUMENTS.filter((document) =>
    document.sections.some((section) =>
      [...section.paragraphs, ...(section.bullets ?? [])].some((line) => line.includes('`')),
    ),
  );

  it('found documents that use the backtick idiom, so this is not vacuous', () => {
    // The privacy policy (cookie names) and the no-ranking stance (a guard and its path) at least.
    expect(documentsWithBackticks.map((document) => document.slug)).toContain('privacy');
    expect(documentsWithBackticks.length).toBeGreaterThanOrEqual(2);
  });

  it.each(documentsWithBackticks.map((document) => [document.slug]))(
    '%s shows no raw delimiter to the reader',
    (slug) => {
      const markup = renderDocument(slug);
      // The rendered *text*, with tags removed — a backtick surviving here is one a reader sees.
      const visible = markup.replace(/<[^>]+>/g, '');

      expect(visible, 'a backtick reached the page instead of becoming a code span').not.toContain('`');
      expect(visible, 'an asterisk pair reached the page instead of becoming emphasis').not.toContain('**');
    },
  );

  it('sets the identifiers in the product’s one mono treatment', () => {
    const markup = renderDocument('privacy');

    expect(markup).toContain('class="data-token"');
    expect(markup).toContain('<code class="data-token">compass_session</code>');
  });

  it('still emphasises the distinction the privacy policy depends on', () => {
    // The regression guard for the change that added code spans: bold must keep working.
    expect(renderDocument('privacy')).toContain('<strong class="font-medium text-ink-strong">');
  });
});

/**
 * An unpaired delimiter renders as itself, rather than marking up the rest of the paragraph.
 *
 * `split` makes the wrong behaviour the default one, which is why this needs a test rather than a
 * comment. `n` delimiters yield `n + 1` segments: a balanced pair leaves the trailing run at an even
 * index where it falls through, but a single stray delimiter puts it at an odd index and marks it up
 * to the end. A missing closing backtick in a published legal document would silently restyle
 * everything after it — and the content module is hand-authored prose, which is exactly where a
 * dropped delimiter happens.
 */
describe('markup that is not closed', () => {
  const renderParagraph = (paragraph: string): string =>
    renderToStaticMarkup(
      <PolicyBody
        document={{
          slug: 'probe',
          title: 'Probe',
          lede: 'A document that exists only in this test.',
          lastUpdated: '2026-08-06',
          sections: [{ heading: 'Heading', paragraphs: [paragraph] }],
        }}
      />,
    );

  it('leaves a stray backtick as a character instead of opening a mono span', () => {
    const markup = renderParagraph('the cookie is set once `and the rest of this sentence is prose');

    expect(markup, 'an unclosed backtick must not set the remainder in mono').not.toContain('<code');
    expect(markup).toContain('once `and the rest');
  });

  it('leaves a stray asterisk pair as characters instead of emboldening the remainder', () => {
    expect(renderParagraph('the retention window is **90 days and then it is deleted')).not.toContain('<strong');
  });

  it('still renders a correctly paired backtick inside a paragraph with a stray asterisk', () => {
    // The two are independent: a typo in one idiom must not disable the other.
    expect(renderParagraph('a **stray asterisk and a good `compass_session` span')).toContain(
      '<code class="data-token">compass_session</code>',
    );
  });

  it('still renders both when both are balanced, so the guard did not disable the feature', () => {
    const markup = renderParagraph('**account data** is held in `compass_session`');

    expect(markup).toContain('<strong class="font-medium text-ink-strong">');
    expect(markup).toContain('<code class="data-token">compass_session</code>');
  });
});
