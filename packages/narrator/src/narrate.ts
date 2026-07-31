import type { SectionKey, StructuredReport } from '@compass/analysis';
import { RENDERER_ID as TEMPLATE_RENDERER_ID, renderReport, type RenderedReport } from '@compass/renderers';

import { describeVerdict, validateGrounding, type GroundingVerdict } from './grounding.js';
import { narrationPayload, sectionRequests, type NarrationSectionRequest } from './payload.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_NARRATION_MODEL,
  NarrationUnavailableError,
  type NarratorPort,
} from './port.js';
import { buildSectionPrompt } from './prompt.js';

/**
 * Bounded retries, and the fail-closed fallback.
 *
 * ## N is three
 *
 * Three attempts per section, then the whole report renders from the template.
 * The number is documented in `docs/DEVELOPMENT.md` under "Narration and
 * grounding" and it is *this* constant, so the documentation and the behaviour
 * cannot drift.
 *
 * Three rather than one because a rejection is often a single stray figure and a
 * regenerated section usually lands; three rather than ten because a model that has
 * fabricated twice on the same payload is not going to be talked out of it, and a
 * manager opening `/` is waiting for the page.
 *
 * ## The fallback is whole-report, not per-section
 *
 * When one section cannot be grounded, *every* section is re-rendered by the
 * template renderer and the report is marked as a fallback. Keeping five narrated
 * sections and substituting the sixth was the alternative, and it is worse: the
 * document would change voice halfway down with nothing on the page saying where,
 * and a reader could not tell which prose had been validated against what. A
 * report is one document with one author.
 *
 * ## Nothing ungrounded is ever returned
 *
 * `narrateReport` has exactly two exits. Either every section was validated —
 * `rendererId: 'narrated'` — or the return value's prose is the template
 * renderer's own output and `fallback` is set. There is no third path, no partial
 * result and no "best effort" flag, which is what makes the stubbed
 * always-fabricating narrator in the tests unable to get prose onto a page.
 */

/** N. Attempts per section, including the first. Documented in docs/DEVELOPMENT.md. */
export const NARRATION_MAX_ATTEMPTS = 3;

export const NARRATED_RENDERER_ID = 'narrated';

export type NarrationAttemptOutcome =
  | 'grounded'
  /** The validator found a token the payload does not contain. */
  | 'rejected'
  /** The provider declined to answer. Terminal: not retried. */
  | 'refused'
  /** The provider errored or timed out. Terminal: not retried. */
  | 'unavailable'
  /** The response was not prose — markup, a code fence, an empty body. */
  | 'malformed';

/** One row of the NarrationTrace table, per attempt. */
export interface NarrationTraceRecord {
  readonly sectionKey: SectionKey;
  readonly narratorId: string;
  /** The model asked for, or the model that answered when those differ. */
  readonly model: string;
  readonly promptHash: string;
  readonly promptVersion: string;
  /** 1-based index of this attempt. */
  readonly attempt: number;
  /** How many attempts this section consumed in total. */
  readonly attemptCount: number;
  readonly outcome: NarrationAttemptOutcome;
  /** Quantities and identifiers the validator could not trace. Named, not counted. */
  readonly untraceableTokens: readonly string[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly proseLength: number;
  /** One sentence, in the product's voice, for the log and the trace row. */
  readonly detail: string;
}

export interface NarratedSection {
  readonly key: SectionKey;
  readonly prose: string;
  readonly attempts: number;
}

/** Why a report was rendered by the template renderer instead of narrated. */
export interface NarrationFallback {
  readonly reason: string;
  /** The section that could not be grounded, when one section is to blame. */
  readonly sectionKey: SectionKey | null;
  readonly outcome: NarrationAttemptOutcome;
}

export interface NarrationResult {
  /** `narrated`, or the template renderer's own id when this is a fallback. */
  readonly rendererId: string;
  /** Null exactly when `rendererId` is `narrated`. */
  readonly fallback: NarrationFallback | null;
  /**
   * The prose a manager reads, per section, in the fixed order.
   *
   * On a fallback these are the template renderer's sections, so a caller that
   * persists this never has to know which path produced it.
   */
  readonly sections: readonly NarratedSection[];
  /** The deterministic render. Always present: it is the fallback and the masthead. */
  readonly rendered: RenderedReport;
  readonly traces: readonly NarrationTraceRecord[];
}

export interface NarrateReportOptions {
  /** Null renders from the template with no attempt and no trace rows. */
  readonly narrator: NarratorPort | null;
  readonly model?: string;
  readonly maxOutputTokens?: number;
  readonly maxAttempts?: number;
  /**
   * The deterministic render, when the caller already has one.
   *
   * The pipeline renders before it narrates — the render is a stage of its own and
   * its result is what gets persisted on a fallback — so passing it here avoids
   * rendering the same report twice. Omitted, this renders it.
   */
  readonly rendered?: RenderedReport;
}

/**
 * Markup, in prose that is contractually markup-free.
 *
 * The system prompt forbids HTML and markdown, and the web view escapes both — so a
 * leaked tag cannot execute. It would still *print*, as a literal `<thinking>` in
 * the middle of a memo, and a stray tag is also the shape a leaked reasoning block
 * takes. Rejecting is cheap (the section is simply retried) and the alternative —
 * stripping the tag — would silently delete text the validator never checked.
 */
const MARKUP_PATTERN = /<\/?[a-zA-Z][^>]*>|```/;

function proseProblem(prose: string): string | null {
  const trimmed = prose.trim();
  if (trimmed.length === 0) return 'the model returned no prose';
  const markup = MARKUP_PATTERN.exec(trimmed);
  if (markup !== null) {
    return `the narration contains markup (\`${markup[0].slice(0, 40)}\`); Compass prose is plain text`;
  }
  return null;
}

/** Collapses the trailing whitespace a model leaves without touching the words. */
const normalize = (prose: string): string =>
  prose
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

interface SectionAttemptResult {
  readonly prose: string | null;
  readonly attempts: number;
  readonly traces: readonly NarrationTraceRecord[];
  readonly failure: NarrationFallback | null;
}

/**
 * One section, up to `maxAttempts` times.
 *
 * Grounding rejection is the only retryable outcome. A refusal and a transport
 * failure are terminal by design: both mean the provider is not going to produce
 * this section, and hammering it delays the fallback a manager is already waiting
 * for. `malformed` *is* retried, because a stray code fence is the kind of thing a
 * second generation fixes.
 */
async function narrateSection(
  narrator: NarratorPort,
  request: NarrationSectionRequest,
  model: string,
  maxOutputTokens: number,
  maxAttempts: number,
): Promise<SectionAttemptResult> {
  const prompt = buildSectionPrompt(request);
  const traces: NarrationTraceRecord[] = [];
  const sectionKey = request.section.key;

  const trace = (
    attempt: number,
    outcome: NarrationAttemptOutcome,
    detail: string,
    extra: {
      model?: string;
      untraceableTokens?: readonly string[];
      inputTokens?: number | null;
      outputTokens?: number | null;
      proseLength?: number;
    } = {},
  ): NarrationTraceRecord => ({
    sectionKey,
    narratorId: narrator.narratorId,
    model: extra.model ?? model,
    promptHash: prompt.promptHash,
    promptVersion: prompt.promptVersion,
    attempt,
    // Overwritten below once the loop knows the real total, so every row for a
    // section agrees about how many attempts that section took.
    attemptCount: attempt,
    outcome,
    untraceableTokens: extra.untraceableTokens ?? [],
    inputTokens: extra.inputTokens ?? null,
    outputTokens: extra.outputTokens ?? null,
    proseLength: extra.proseLength ?? 0,
    detail,
  });

  const finish = (prose: string | null, failure: NarrationFallback | null): SectionAttemptResult => ({
    prose,
    attempts: traces.length,
    traces: traces.map((row) => ({ ...row, attemptCount: traces.length })),
    failure,
  });

  let lastVerdict: GroundingVerdict | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await narrator.narrate({
        model,
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens,
        sectionKey,
        attempt,
      });
    } catch (cause) {
      const detail =
        cause instanceof NarrationUnavailableError
          ? cause.message
          : `the narrator threw while writing \`${sectionKey}\`: ${cause instanceof Error ? cause.message : String(cause)}`;
      traces.push(trace(attempt, 'unavailable', detail));
      return finish(null, { reason: detail, sectionKey, outcome: 'unavailable' });
    }

    if (response.refusal !== null) {
      const detail = `\`${sectionKey}\`: ${response.refusal}`;
      traces.push(
        trace(attempt, 'refused', detail, {
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
        }),
      );
      return finish(null, { reason: detail, sectionKey, outcome: 'refused' });
    }

    const prose = normalize(response.prose);
    const shapeProblem = proseProblem(prose);
    if (shapeProblem !== null) {
      traces.push(
        trace(attempt, 'malformed', `\`${sectionKey}\`: ${shapeProblem}`, {
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          proseLength: prose.length,
        }),
      );
      continue;
    }

    const verdict = validateGrounding(prose, request);
    lastVerdict = verdict;

    if (verdict.grounded) {
      traces.push(
        trace(attempt, 'grounded', describeVerdict(verdict), {
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          proseLength: prose.length,
        }),
      );
      return finish(prose, null);
    }

    traces.push(
      trace(attempt, 'rejected', describeVerdict(verdict), {
        model: response.model,
        untraceableTokens: verdict.untraceable.map((token) => token.text),
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        proseLength: prose.length,
      }),
    );
  }

  const reason =
    lastVerdict === null
      ? `\`${sectionKey}\` produced no usable prose in ${maxAttempts} attempts`
      : `\`${sectionKey}\` could not be grounded in ${maxAttempts} attempts; ` +
        `last rejection named ${lastVerdict.untraceable.map((token) => `\`${token.text}\``).join(', ')}`;

  return finish(null, { reason, sectionKey, outcome: lastVerdict === null ? 'malformed' : 'rejected' });
}

/**
 * The narrated report, or the template-rendered one — never a mixture.
 *
 * The deterministic render happens first and unconditionally. It is the fallback,
 * it supplies the masthead and freshness line that narration never touches, and
 * running it up front means a report is never left with nothing to show because
 * narration failed late.
 */
export async function narrateReport(
  report: StructuredReport,
  options: NarrateReportOptions,
): Promise<NarrationResult> {
  const rendered = options.rendered ?? renderReport(report);

  const templateSections = (): readonly NarratedSection[] =>
    rendered.sections.map((section) => ({ key: section.key, prose: section.prose, attempts: 0 }));

  if (options.narrator === null) {
    return {
      rendererId: TEMPLATE_RENDERER_ID,
      fallback: {
        reason:
          'No narrator is configured, so this report was written by the deterministic template renderer. ' +
          'Every section, figure and link is complete; only the wording is templated.',
        sectionKey: null,
        outcome: 'unavailable',
      },
      sections: templateSections(),
      rendered,
      traces: [],
    };
  }

  const narrator = options.narrator;
  const maxAttempts = options.maxAttempts ?? NARRATION_MAX_ATTEMPTS;
  const model = options.model ?? DEFAULT_NARRATION_MODEL;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const traces: NarrationTraceRecord[] = [];
  const narrated: NarratedSection[] = [];

  // Sequential rather than parallel: six concurrent requests is a burst that
  // rate-limits an unlucky tenant into a fallback, and the six sections are read
  // in a fixed order anyway so there is no latency the reader can perceive.
  for (const request of sectionRequests(narrationPayload(report))) {
    const attempt = await narrateSection(narrator, request, model, maxOutputTokens, maxAttempts);
    traces.push(...attempt.traces);

    if (attempt.prose === null) {
      const failure = attempt.failure ?? {
        reason: `\`${request.section.key}\` could not be narrated`,
        sectionKey: request.section.key,
        outcome: 'rejected' as const,
      };
      return {
        rendererId: TEMPLATE_RENDERER_ID,
        fallback: failure,
        sections: templateSections(),
        rendered,
        traces,
      };
    }

    narrated.push({ key: request.section.key, prose: attempt.prose, attempts: attempt.attempts });
  }

  return { rendererId: NARRATED_RENDERER_ID, fallback: null, sections: narrated, rendered, traces };
}
