import {
  DERIVED_RETENTION_CHOICES,
  LLM_MINIMIZATION_MODES,
  RAW_RETENTION_CHOICES,
  type DerivedRetentionYears,
  type ErrorReportingConsent,
  type LlmMinimizationMode,
  type RawRetentionDays,
} from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject } from '../../../../lib/auth/http';
import { saveRetention } from '../../../../lib/privacy-source';

/**
 * `/api/privacy/settings` — the retention windows and the narration mode.
 *
 * Owner only, and the three fields it accepts are the three closed vocabularies the
 * database also constrains. Both halves earn their place: the constraint makes a fourth
 * value unwritable by any path, and this validator is what turns the refusal into a
 * sentence naming the choices — a CHECK violation surfaces as a driver error a manager
 * cannot act on.
 *
 * ## `derivedRetentionYears: null` is a value, not an omission
 *
 * `null` means indefinite. An absent key means "leave it alone". Collapsing the two would
 * make "keep reports forever" unexpressible over HTTP, so the two are distinguished
 * explicitly here and threaded all the way down to the UPDATE.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/privacy/settings';

function readRawWindow(
  body: Record<string, unknown>,
): { readonly value: RawRetentionDays | undefined } | { readonly response: NextResponse } {
  const raw = body['rawEventRetentionDays'];
  if (raw === undefined) return { value: undefined };
  if (typeof raw !== 'number' || !(RAW_RETENTION_CHOICES as readonly number[]).includes(raw)) {
    return {
      response: jsonError(
        'invalid_request',
        `\`rawEventRetentionDays\` must be one of ${RAW_RETENTION_CHOICES.join(', ')} days. Compass offers a closed ` +
          'set rather than a free number because a typo here silently deletes the week somebody was about to read.',
        400,
      ),
    };
  }
  return { value: raw as RawRetentionDays };
}

function readDerivedWindow(
  body: Record<string, unknown>,
): { readonly value: DerivedRetentionYears | undefined; readonly present: boolean } | { readonly response: NextResponse } {
  if (!('derivedRetentionYears' in body)) return { value: undefined, present: false };
  const raw = body['derivedRetentionYears'];

  if (raw === null) return { value: null, present: true };
  // Checked against the exported choices rather than a literal, so adding a fourth window is one
  // edit rather than two that could disagree. `null` is filtered out because it was handled above.
  const years = DERIVED_RETENTION_CHOICES.filter((choice): choice is 1 | 3 | 7 => choice !== null);
  if (typeof raw !== 'number' || !(years as readonly number[]).includes(raw)) {
    return {
      response: jsonError(
        'invalid_request',
        `\`derivedRetentionYears\` must be ${years.join(', ')} — or \`null\` for indefinite, which is a deliberate choice rather ` +
          'than the absence of one. Reports are the product; deleting them early destroys the continuity the ' +
          'whole design rests on.',
        400,
      ),
    };
  }
  return { value: raw as DerivedRetentionYears, present: true };
}

function readMode(
  body: Record<string, unknown>,
): { readonly value: LlmMinimizationMode | undefined } | { readonly response: NextResponse } {
  const raw = body['llmMinimizationMode'];
  if (raw === undefined) return { value: undefined };
  if (typeof raw !== 'string' || !(LLM_MINIMIZATION_MODES as readonly string[]).includes(raw)) {
    return {
      response: jsonError(
        'invalid_request',
        '`llmMinimizationMode` must be `full`, `redacted` or `none`. `redacted` sends pseudonyms and substitutes ' +
          'the real names back on this machine; `none` makes no request at all and renders through the template ' +
          'renderer.',
        400,
      ),
    };
  }
  return { value: raw as LlmMinimizationMode };
}

/**
 * The error-reporting answer. Owner-only like the rest of this route, because it is the
 * organization's posture rather than one visitor's preference.
 *
 * `unset` is refused as an *input* while remaining a legal stored value. It means "nobody has been
 * asked", so a request that set it would be un-asking a question that had already been answered —
 * deleting a consent record rather than withdrawing consent, and putting the notice back up as
 * though the decision had never happened. Withdrawal is `denied`: a different statement, a
 * different audit row, and one that stays findable.
 */
function readErrorReportingConsent(
  body: Record<string, unknown>,
): { readonly value: ErrorReportingConsent | undefined } | { readonly response: NextResponse } {
  const raw = body['errorReportingConsent'];
  if (raw === undefined) return { value: undefined };
  if (raw !== 'granted' && raw !== 'denied') {
    return {
      response: jsonError(
        'invalid_request',
        '`errorReportingConsent` must be `granted` or `denied`. It decides whether a scrubbed stack trace may ' +
          'leave this deployment when something breaks. Either answer ends the notice and either can be changed ' +
          'again later; `unset` is not accepted, because that is the state before anybody answered rather than ' +
          'an answer.',
        400,
      ),
    };
  }
  return { value: raw };
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'PATCH' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const rawWindow = readRawWindow(parsed.body);
  if ('response' in rawWindow) return rawWindow.response;
  const derivedWindow = readDerivedWindow(parsed.body);
  if ('response' in derivedWindow) return derivedWindow.response;
  const mode = readMode(parsed.body);
  if ('response' in mode) return mode.response;
  const consent = readErrorReportingConsent(parsed.body);
  if ('response' in consent) return consent.response;

  if (
    rawWindow.value === undefined &&
    !derivedWindow.present &&
    mode.value === undefined &&
    consent.value === undefined
  ) {
    return jsonError(
      'invalid_request',
      'Send at least one of `rawEventRetentionDays`, `derivedRetentionYears`, `llmMinimizationMode` or ' +
        '`errorReportingConsent`.',
      400,
    );
  }

  try {
    const applied = await saveRetention(
      admitted.scoped,
      {
        ...(rawWindow.value === undefined ? {} : { rawEventRetentionDays: rawWindow.value }),
        ...(derivedWindow.present ? { derivedRetentionYears: derivedWindow.value } : {}),
        ...(mode.value === undefined ? {} : { llmMinimizationMode: mode.value }),
        ...(consent.value === undefined ? {} : { errorReportingConsent: consent.value }),
      },
      admitted.identity,
      admitted.now,
    );

    return jsonOk({
      llmMinimizationMode: applied,
      detail:
        'Saved. The next scheduled purge applies the new window; nothing is deleted at the moment you change it, ' +
        'so shortening a window gives you until the next purge to change your mind. The narration mode takes ' +
        'effect on the next report Compass generates.',
    });
  } catch (error) {
    return failure(error);
  }
}
