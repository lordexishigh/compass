import type { AlignmentView } from '../lib/view-model';

/**
 * The one-click evidence panel for an alignment verdict.
 *
 * A manager must be able to check a flag *before* repeating it to a person, and
 * they must be able to do it in one click from the report. So this is a native
 * `<details>` disclosure rather than a modal or a client-side gutter: one click or
 * one Enter key opens it, it works with JavaScript disabled, it is keyboard- and
 * screen-reader-navigable for free, and the same markup renders identically in the
 * static HTML report the smoke test fetches. A React state toggle would have given
 * up all four of those to gain an animation.
 *
 * What it shows is *the tier that actually resolved the verdict*, never a summary
 * of all three:
 *
 *  - **configured** — the chain of node ids, leaf first, as a mono trail;
 *  - **inferred** — the searched string with the matched span underlined *at the
 *    offset Compass recorded*, so the highlight cannot drift;
 *  - **semantic** — both compared texts, the shared wording, the score and the
 *    threshold it was compared against.
 *
 * The confidence and the threshold are printed together, always, in every case
 * including unattributed. "0.62" alone invites the reader to guess what it was
 * measured against, and that comparison is the entire safety argument for OFF-GOAL.
 *
 * Density is deliberate and it is the design's own rule: prose is airy, evidence is
 * dense — 13px, tight leading, tabular mono, 8px rows. The contrast between the two
 * is a large part of the product's signature.
 */
export function AlignmentEvidence({ alignment }: { readonly alignment: AlignmentView }) {
  return (
    <details className="evidence-disclosure mt-3" data-alignment-evidence={alignment.kind}>
      <summary
        className="evidence-disclosure__summary"
        aria-controls={alignment.panelId}
        data-alignment-affordance={alignment.tier}
      >
        <span aria-hidden="true" className="evidence-disclosure__caret" />
        <span className="evidence-disclosure__label">
          {alignment.kind === 'off_goal' ? 'How Compass resolved this' : 'What Compass compared'}
        </span>
        <span className="evidence-disclosure__meta">{alignment.summary}</span>
      </summary>

      <div id={alignment.panelId} className="evidence-disclosure__body">
        <dl className="evidence-rows">
          <Row label="Tier">
            <span>{alignment.tierLabel}</span>
          </Row>

          <Row label="Confidence">
            <span className="data-token">{alignment.confidenceLabel}</span>
            <span className="evidence-rows__aside">
              {alignment.clearsThreshold ? 'at or above' : 'below'} the threshold{' '}
              <span className="data-token">{alignment.thresholdId}</span> sets, which is{' '}
              <span className="data-token">{alignment.thresholdLabel}</span>
            </span>
          </Row>

          {alignment.objectiveNodeId !== null && (
            <Row label="Objective">
              <span className="data-token">{alignment.objectiveNodeId}</span>
              {alignment.objectiveTitle !== null && (
                <span className="evidence-rows__aside">{alignment.objectiveTitle}</span>
              )}
            </Row>
          )}

          {alignment.chain.length > 0 && (
            <Row label="Chain">
              <span className="evidence-chain-trail">
                {alignment.chain.map((node, index) => (
                  <span key={node.nodeId}>
                    {index > 0 && <span aria-hidden="true" className="evidence-chain-trail__arrow"> → </span>}
                    <span className="data-token" title={node.title ?? undefined}>
                      {node.nodeId}
                    </span>
                  </span>
                ))}
              </span>
              <span className="evidence-rows__aside">
                Leaf first: the goal the work sits on, then what that goal serves.
              </span>
            </Row>
          )}

          {alignment.highlight !== null && (
            <Row label="Matched">
              <span className="evidence-matched">
                {alignment.highlight.before}
                <span className="evidence-matched__span">{alignment.highlight.match}</span>
                {alignment.highlight.after}
              </span>
              <span className="evidence-rows__aside">
                Found in {alignment.highlight.caption}, at character{' '}
                <span className="data-token">{alignment.highlight.before.length}</span>.
              </span>
            </Row>
          )}

          {alignment.comparison !== null && (
            <Row label="Compared">
              <span className="evidence-compared">
                <span className="evidence-compared__line">
                  <span className="evidence-compared__side">this work</span>
                  <q>{alignment.comparison.subjectText}</q>
                </span>
                <span className="evidence-compared__line">
                  <span className="evidence-compared__side">the goal</span>
                  <q>{alignment.comparison.goalText}</q>
                </span>
              </span>
              <span className="evidence-rows__aside">
                {alignment.comparison.sharedTokens.length === 0
                  ? 'They share no wording at all, which is why the score is what it is.'
                  : `Shared wording: ${alignment.comparison.sharedTokens.join(', ')}.`}
              </span>
            </Row>
          )}

          {alignment.subjectLabels.length > 0 && (
            <Row label={alignment.subjectLabels.length === 1 ? 'Artifact' : 'Artifacts'}>
              <span className="data-token">{alignment.subjectLabels.join(' · ')}</span>
            </Row>
          )}
        </dl>

        <p className="evidence-disclosure__note">
          {alignment.kind === 'off_goal'
            ? 'Compass compares the wording of the work with the wording of every goal it holds. It labels work off-goal only above the threshold and only when a named objective the organization is no longer pursuing explains it better than the chain the work sits on.'
            : 'Nothing here cleared the threshold, so Compass has stated no verdict and named no person. If you know what this work served, the goal hierarchy is where to say so.'}
        </p>
      </div>
    </details>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="evidence-rows__row">
      <dt className="evidence-rows__term">{label}</dt>
      <dd className="evidence-rows__value">{children}</dd>
    </div>
  );
}
