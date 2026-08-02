import { collapseWhitespace, escapeHtml, renderProseHtml, renderProseText, type RenderedReport } from '@compass/renderers';

import { orderedSections } from './spine.js';

/**
 * The email channel: the whole report, inline.
 *
 * The rule this file exists to keep is one sentence long — **there is no click-to-view stub.**
 * A daily that arrives as "your report is ready, click here" is not a daily; it is a
 * notification about a daily, and it dies the first week because reading it costs a context
 * switch at 08:45. So every one of the six sections is written into the body in full, in the
 * fixed order, in both the HTML and the text part.
 *
 * ## Two parts, one source
 *
 * Both parts are rendered from the same `RenderedReport` through the shared prose sanitizer:
 * `renderProseHtml` for the HTML part and `renderProseText` for the text part. Neither channel
 * writes a sentence of its own — the deterministic renderer in `@compass/renderers` wrote every
 * sentence, which is what makes the email and the web page unable to disagree about the same
 * report.
 *
 * ## Why inline CSS and a table-free layout
 *
 * Mail clients are not browsers. There is no external stylesheet, no `<style>` block that
 * Gmail would strip, no web font, and no image — the design brief's reading column survives as
 * a single centred block with inline styles, and the type falls back to the client's serif
 * without changing what the report says. No chart, no sparkline, no tracking pixel.
 */

/** The one meaning colour carries here: emerald for a verified positive fact. */
const INK = '#18181b';
const INK_MUTED = '#52525b';
const INK_FAINT = '#71717a';
const RULE = '#e4e4e7';
const VERIFIED = '#059669';
/**
 * Teal — the manager's own authorship.
 *
 * The design's second and only other meaning for colour: emerald marks a verified positive fact,
 * teal marks the manager's own hand. A feedback link is an invitation to author something, so it
 * carries teal and not emerald — dismissing a risk is not a win.
 */
const ACCENT = '#14b8a6';

/**
 * A header value with every CR and LF removed.
 *
 * This is the header-injection defence, and it is deliberately not "escape the value". A mail
 * header ends at a newline, so a ticket titled `fine\r\nBcc: attacker@evil.test` reaching a
 * `Subject:` would *become* a Bcc header — the payload does not need to be valid HTML or valid
 * anything, it needs one CRLF. `collapseWhitespace` folds every run of whitespace, newlines
 * included, into single spaces, so the words survive and the header cannot be split.
 *
 * Applied to every header value this module produces, not only the subject: a display name and
 * a list-id are equally header values.
 */
export const safeHeaderValue = (value: string): string => collapseWhitespace(value);

export interface EmailRenderOptions {
  /** Absolute URL of the report on the web, for the one "read in Compass" footer link. */
  readonly reportUrl: string;
  /**
   * The RFC 8058 one-click unsubscribe endpoint, absolute.
   *
   * A URL rather than a mailto: a mail client's one-click button issues a POST, and a mailto
   * would put the burden of parsing an email back on the operator.
   */
  readonly unsubscribeUrl: string;
  /** The address the report was addressed to, for the footer's own statement. */
  readonly recipient: string;
  /**
   * One entry per actionable claim: the signed, single-purpose links its buttons point at.
   *
   * Absent means the deployment has no `COMPASS_FEEDBACK_LINK_SECRET`, in which case the email
   * carries no action links and the footer says so. That is the honest degradation: Compass will
   * not sign a dismissal link with a default key, because an HMAC under a known secret is not a
   * signature and the link would let anybody dismiss anybody's risk.
   */
  readonly itemActions?: readonly EmailItemActions[];
}

/** One claim's feedback links, already signed and scoped by the caller. */
export interface EmailItemActions {
  readonly itemStableId: string;
  readonly headline: string;
  readonly actions: readonly { readonly action: string; readonly label: string; readonly url: string }[];
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /**
   * Headers the transport must send verbatim.
   *
   * `List-Unsubscribe` and `List-Unsubscribe-Post` together are RFC 8058: the pair is what
   * makes a mail client show its own one-click unsubscribe button and POST to it without the
   * reader leaving their inbox. Sending only the first gets the old mailto behaviour; sending
   * only the second is meaningless.
   */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The subject line.
 *
 * The masthead, which already reads `Compass — platform — 2026-07-31`. Passed through the
 * header sanitizer because a team name is ingested text like any other.
 */
export const emailSubject = (report: RenderedReport): string => safeHeaderValue(report.masthead);

const paragraph = (prose: string, style: string): string =>
  renderProseHtml(prose)
    .split('\n')
    .map((line) => line.replace('<p>', `<p style="${style}">`))
    .join('\n');

const BODY_STYLE = `margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:${INK};`;
const LEAD_STYLE = `margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:${INK};`;
const TRAILER_STYLE = `margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;color:${INK_MUTED};font-style:italic;`;

/**
 * The whole report as an email body.
 *
 * Every section is emitted, including an empty one: a section with nothing to say states that
 * in the product's voice ("Nothing is blocked on a signal Compass can see"), because a
 * silently omitted section reads as a section that was forgotten. That statement is already in
 * the rendered prose, so this function does not have to know about it — it just never skips.
 */
export function renderEmail(report: RenderedReport, options: EmailRenderOptions): RenderedEmail {
  const sections = orderedSections(report);
  const actionsByItem = new Map((options.itemActions ?? []).map((entry) => [entry.itemStableId, entry]));

  const html: string[] = [
    `<div style="margin:0;padding:24px 16px;background:#ffffff;">`,
    `<div style="max-width:36rem;margin:0 auto;">`,
    `<p style="margin:0 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${INK_FAINT};">daily report</p>`,
    `<h1 style="margin:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.25;color:${INK};font-weight:600;">${escapeHtml(
      report.masthead,
    )}</h1>`,
    `<p style="margin:0 0 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:${INK_MUTED};">${escapeHtml(
      report.freshness,
    )}</p>`,
  ];

  const text: string[] = [report.masthead, '', report.freshness, ''];

  // The change line, above the six sections in both parts. On a morning when nothing moved it is
  // the whole report, and a reader who has that sentence at the top does not scroll to find it out.
  if (report.changeLine.length > 0) {
    html.push(
      `<p style="margin:0 0 24px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:${INK};">${escapeHtml(
        report.changeLine,
      )}</p>`,
    );
    text.push(renderProseText(report.changeLine), '');
  }

  for (const section of sections) {
    html.push(
      `<div style="border-top:1px solid ${RULE};padding-top:16px;margin-top:24px;">`,
      `<p style="margin:0 0 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${INK_FAINT};">` +
        `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(section.numeral)}</span> ${escapeHtml(
          section.title,
        )}</p>`,
      paragraph(section.lead, LEAD_STYLE),
    );

    for (const claim of section.claims) {
      html.push(paragraph(claim.prose, BODY_STYLE));

      // The links sit directly under the claim they act on. A row of verbs collected at the foot of
      // the email would be a row of verbs a manager cannot map back onto four different blockers.
      const entry = actionsByItem.get(claim.stableId);
      if (entry !== undefined && entry.actions.length > 0) {
        html.push(
          `<p style="margin:0 0 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.7;color:${INK_FAINT};">` +
            entry.actions
              .map(
                (action) =>
                  `<a href="${escapeHtml(action.url)}" style="color:${ACCENT};text-decoration:none;border-bottom:1px solid ${RULE};">${escapeHtml(
                    action.label,
                  )}</a>`,
              )
              .join(' &nbsp;·&nbsp; ') +
            '</p>',
        );
      }
    }
    if (section.trailer !== null) {
      html.push(paragraph(section.trailer, TRAILER_STYLE));
    }
    html.push('</div>');

    text.push(`${section.numeral} ${section.title.toUpperCase()}`, '', renderProseText(section.prose), '');

    // The text part gets the same links, listed after the section, because a plain-text reader is
    // owed the same affordances and a bare label with no URL would be a dead button.
    for (const claim of section.claims) {
      const entry = actionsByItem.get(claim.stableId);
      if (entry === undefined || entry.actions.length === 0) continue;
      text.push(
        renderProseText(entry.headline),
        ...entry.actions.map((action) => `  ${action.label}: ${action.url}`),
        '',
      );
    }
  }

  html.push(
    `<div style="border-top:1px solid ${RULE};padding-top:16px;margin-top:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.7;color:${INK_FAINT};">`,
    // The report is already above in full. This link is for the evidence gutter and the
    // feedback actions, which an email cannot carry — not for reading the report.
    `<p style="margin:0 0 6px;">The full report is above. <a href="${escapeHtml(options.reportUrl)}" style="color:${VERIFIED};">Open it in Compass</a> to follow the evidence for any claim.</p>`,
    `<p style="margin:0;">Sent to ${escapeHtml(options.recipient)}. <a href="${escapeHtml(options.unsubscribeUrl)}" style="color:${INK_MUTED};">Unsubscribe</a>.</p>`,
    '</div>',
    '</div>',
    '</div>',
  );

  text.push(
    '---',
    `The full report is above. Open it in Compass to follow the evidence for any claim: ${options.reportUrl}`,
    `Sent to ${options.recipient}. Unsubscribe: ${options.unsubscribeUrl}`,
  );

  return {
    subject: emailSubject(report),
    html: html.join('\n'),
    text: `${text.join('\n').trimEnd()}\n`,
    headers: listUnsubscribeHeaders(options.unsubscribeUrl),
  };
}

/**
 * RFC 8058, both halves.
 *
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is what tells the client it may POST
 * without a confirmation step, and it is only meaningful next to the URL. Gmail and Outlook
 * show their own unsubscribe affordance when both are present, which is worth more than a link
 * in the footer: an unsubscribe a reader cannot find becomes a spam report.
 */
export function listUnsubscribeHeaders(unsubscribeUrl: string): Readonly<Record<string, string>> {
  return {
    'List-Unsubscribe': `<${safeHeaderValue(unsubscribeUrl)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
