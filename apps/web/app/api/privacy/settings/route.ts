import {
  DERIVED_RETENTION_CHOICES,
  LLM_MINIMIZATION_MODES,
  RAW_RETENTION_CHOICES,
  type DerivedRetentionYears,
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
  if (typeof raw !== 'number' || ![1, 3, 7].includes(raw)) {
    return {
      response: jsonError(
        'invalid_request',
        '`derivedRetentionYears` must be 1, 3 or 7 — or `null` for indefinite, which is a deliberate choice rather ' +
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

  if (rawWindow.value === undefined && !derivedWindow.present && mode.value === undefined) {
    return jsonError(
      'invalid_request',
      'Send at least one of `rawEventRetentionDays`, `derivedRetentionYears` or `llmMinimizationMode`.',
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
