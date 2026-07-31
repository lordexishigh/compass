import Link from 'next/link';

import type { EvidenceLinkView } from '../lib/view-model';

/**
 * The superscript evidence markers.
 *
 * Every computed claim carries one marker per artifact behind it, and every
 * marker is a real link to a real page inside Compass showing the commit SHA,
 * pull request number or tracker key. That is the difference between a report a
 * manager believes and one they can check.
 *
 * The markers are superscript because the prose is the product: a row of chips
 * under every sentence would turn a memo into a dashboard. The label is still
 * reachable — it is the link's accessible name, and it is spelled out again in
 * the evidence line beneath the claim for anyone reading on a phone.
 */
export function EvidenceMarkers({ evidence }: { readonly evidence: readonly EvidenceLinkView[] }) {
  if (evidence.length === 0) return null;

  return (
    <span className="whitespace-nowrap">
      {evidence.map((reference) => (
        <Link
          key={`${reference.kind}:${reference.href}`}
          href={reference.href}
          title={reference.description}
          className="ml-0.5 align-super font-mono text-[10px] text-verified-text underline decoration-transparent underline-offset-2 transition-colors duration-150 hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <span aria-hidden="true">{reference.marker}</span>
          <span className="sr-only">Evidence: {reference.description}</span>
        </Link>
      ))}
    </span>
  );
}

/**
 * The evidence line: the same artifacts again, spelled out and openable.
 *
 * A 10px superscript is a small tap target and an easy thing to miss, so the
 * chain is repeated in full beneath the claim. The markers are for the reader
 * following the argument; this is for the reader who wants to go and look.
 */
export function EvidenceChain({ evidence }: { readonly evidence: readonly EvidenceLinkView[] }) {
  if (evidence.length === 0) return null;

  return (
    <p className="mt-2 text-[13px] leading-relaxed text-ink-faint">
      <span className="sr-only">Evidence: </span>
      {evidence.map((reference, index) => (
        <span key={`${reference.kind}:${reference.href}`}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          <Link
            href={reference.href}
            className="data-token underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {reference.label}
            <span className="sr-only"> — {reference.description}</span>
          </Link>
        </span>
      ))}
    </p>
  );
}
