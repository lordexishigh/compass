import { ARTIFACT_ROUTE_KINDS, artifactHref, isArtifactRouteKind } from '@compass/pipeline';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArtifactDetail } from '../components/artifact-detail';
import { identifiersOf, type ArtifactView } from '../lib/artifact-source';

import { storedBundle } from './helpers/report-fixture';

const evidenceFor = (stableId: string) =>
  storedBundle()
    .sections.flatMap((section) => section.items)
    .find((item) => item.stableId === stableId)?.evidence[0];

const view = (overrides: Partial<ArtifactView> = {}): ArtifactView => ({
  kind: 'pull_request',
  artifactId: 'pr-883',
  knownKind: true,
  title: 'pull request #883',
  sourceKey: 'primary-code',
  identifiers: identifiersOf(evidenceFor('yesterday:ticket:DEV-501')),
  claims: [
    {
      reportId: 'report-1',
      reportDate: '2026-07-31',
      sectionKey: 'yesterday',
      sectionTitle: 'Yesterday',
      sectionOrdinal: 1,
      headline: 'DEV-501 via #883 — Batch the checkout writer',
      detail: 'Reached R3 accepted.',
    },
  ],
  ...overrides,
});

describe('the artifact detail page', () => {
  it('shows the underlying identifiers the claim was built from', () => {
    const markup = renderToStaticMarkup(<ArtifactDetail artifact={view()} />);

    expect(markup).toContain('Tracker key');
    expect(markup).toContain('DEV-501');
    expect(markup).toContain('Source record');
    expect(markup).toContain('issue-DEV-501');
  });

  it('lists every claim that cited the artifact, with the section it sat in', () => {
    const markup = renderToStaticMarkup(<ArtifactDetail artifact={view()} />);

    expect(markup).toContain('2026-07-31');
    expect(markup).toContain('Yesterday');
    expect(markup).toContain('Batch the checkout writer');
  });

  it('states an uncited artifact rather than rendering an empty page', () => {
    const markup = renderToStaticMarkup(<ArtifactDetail artifact={view({ claims: [] })} />);

    expect(markup).toContain('No report has cited this artifact yet');
    expect(markup).toContain('stated-absence');
  });

  it('still resolves a kind it has no page for, and says which kind that was', () => {
    const markup = renderToStaticMarkup(
      <ArtifactDetail artifact={view({ kind: 'wiki_page', knownKind: false, identifiers: [], claims: [] })} />,
    );

    expect(markup).toContain('no detail page for artifacts of kind');
    expect(markup).toContain('wiki_page');
  });

  it('offers a way back to the report', () => {
    expect(renderToStaticMarkup(<ArtifactDetail artifact={view()} />)).toContain('href="/"');
  });

  it('carries no chart, canvas or svg either', () => {
    const markup = renderToStaticMarkup(<ArtifactDetail artifact={view()} />).toLowerCase();

    for (const forbidden of ['<canvas', '<svg', 'chart', 'sparkline', 'gauge']) {
      expect(markup).not.toContain(forbidden);
    }
  });
});

describe('the typed identifier columns', () => {
  it('surfaces a commit SHA as its own labelled field', () => {
    const identifiers = identifiersOf(evidenceFor('win:ticket:DEV-501'));

    expect(identifiers.map((entry) => entry.label)).toContain('Commit SHA');
    expect(identifiers.find((entry) => entry.label === 'Commit SHA')?.value).toBe('7a8b9c0d1e2f');
  });

  it('surfaces a pull request number as its own labelled field', () => {
    const pullRequest = storedBundle()
      .sections.flatMap((section) => section.items)
      .flatMap((item) => item.evidence)
      .find((reference) => reference.kind === 'pull_request');

    expect(identifiersOf(pullRequest).map((entry) => entry.value)).toContain('#883');
  });

  it('says nothing at all when there is no evidence row to read', () => {
    expect(identifiersOf(undefined)).toEqual([]);
  });
});

describe('the artifact route contract', () => {
  it('builds one path shape for every kind the port produces', () => {
    for (const kind of ARTIFACT_ROUTE_KINDS) {
      expect(artifactHref(kind, 'checkout-web:abc')).toBe(`/artifact/${kind}/checkout-web%3Aabc`);
      expect(isArtifactRouteKind(kind)).toBe(true);
    }
  });

  it('rejects a kind Compass does not produce, without throwing', () => {
    expect(isArtifactRouteKind('wiki_page')).toBe(false);
    expect(artifactHref('wiki_page', 'x')).toBe('/artifact/wiki_page/x');
  });
});
