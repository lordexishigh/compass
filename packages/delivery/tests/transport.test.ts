import { ResendEmailTransport, deliveryIdempotencyKey, renderEmail, type ScheduledDelivery } from '@compass/delivery';
import { describe, expect, it } from 'vitest';

import { renderedReport } from './helpers/report.js';

/**
 * The provider-side idempotency key.
 *
 * This exists because of a bug worth stating plainly: the key was the email *subject*, which is
 * the masthead — `Compass — platform — 2026-08-03`, identical for every recipient of the same
 * team and date. Resend's idempotency keys are account-scoped, so the first subscriber's send
 * won and every other subscriber's copy was deduplicated away at the provider while this
 * transport still answered `sent` and returned the *first* message's id. Six managers on one
 * team would have shared one email between them and nothing anywhere would have said so.
 */

const OPTIONS = {
  reportUrl: 'https://compass.acme.example/reports/2026-08-03',
  unsubscribeUrl: 'https://compass.acme.example/api/delivery/unsubscribe?token=abc',
  recipient: 'priya@acme.example',
} as const;

const delivery = (overrides: Partial<ScheduledDelivery> = {}): ScheduledDelivery => ({
  subscriptionId: 'sub-priya-email',
  deliveryDate: '2026-08-03',
  scopeKind: 'team',
  scopeKey: 'platform',
  ...overrides,
});

/** Records the request Resend would have received. */
const recordingFetch = () => {
  const calls: { readonly headers: Record<string, string>; readonly body: unknown }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response(JSON.stringify({ id: `resend-${calls.length}` }), { status: 200 });
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
};

describe('the Resend idempotency key', () => {
  it('is derived from the scheduled delivery, not from the message', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const transport = new ResendEmailTransport({
      apiKey: 'test-key',
      from: 'Compass <daily@acme.example>',
      fetchImpl,
    });

    const rendered = renderEmail(renderedReport(), OPTIONS);
    await transport.send({ to: OPTIONS.recipient, rendered, delivery: delivery() });

    expect(calls[0]?.headers['idempotency-key']).toBe(
      'compass:sub-priya-email:2026-08-03:team:platform',
    );
    // Explicitly *not* the subject, which is the whole regression.
    expect(calls[0]?.headers['idempotency-key']).not.toBe(rendered.subject);
  });

  it('differs between two recipients of the identical report', async () => {
    // The failure in one assertion: same masthead, same body, two subscribers — and two keys,
    // so Resend delivers two messages instead of deduplicating the second away.
    const { calls, fetchImpl } = recordingFetch();
    const transport = new ResendEmailTransport({
      apiKey: 'test-key',
      from: 'Compass <daily@acme.example>',
      fetchImpl,
    });

    const rendered = renderEmail(renderedReport(), OPTIONS);

    await transport.send({ to: 'priya@acme.example', rendered, delivery: delivery() });
    await transport.send({
      to: 'marcus@acme.example',
      rendered,
      delivery: delivery({ subscriptionId: 'sub-marcus-email' }),
    });

    const keys = calls.map((call) => call.headers['idempotency-key']);
    expect(new Set(keys).size, 'two subscribers must not share an idempotency key').toBe(2);
    // And the subject really is identical, so the key is the only thing keeping them apart.
    expect(calls[0]?.body).toHaveProperty('subject', rendered.subject);
    expect(calls[1]?.body).toHaveProperty('subject', rendered.subject);
  });

  it('is stable across a retry of the same send, so the provider deduplicates that', async () => {
    // The other half of the requirement: a retried attempt must reuse the key, or a transient
    // failure followed by a success would deliver twice.
    expect(deliveryIdempotencyKey(delivery())).toBe(deliveryIdempotencyKey(delivery()));
  });

  it('separates the two sends of a `both` subscription', async () => {
    // Merged and per-team are distinct scheduled deliveries for one subscription.
    expect(deliveryIdempotencyKey(delivery({ scopeKind: 'merged', scopeKey: '*' }))).not.toBe(
      deliveryIdempotencyKey(delivery()),
    );
  });

  it('separates consecutive days', () => {
    expect(deliveryIdempotencyKey(delivery({ deliveryDate: '2026-08-04' }))).not.toBe(
      deliveryIdempotencyKey(delivery()),
    );
  });
});

describe('a transport with no key configured', () => {
  it('reports `skipped` naming the variable rather than throwing', async () => {
    const transport = new ResendEmailTransport({ from: 'Compass <daily@acme.example>' });
    const outcome = await transport.send({
      to: OPTIONS.recipient,
      rendered: renderEmail(renderedReport(), OPTIONS),
      delivery: delivery(),
    });

    expect(transport.configured).toBe(false);
    expect(outcome.status).toBe('skipped');
    expect(outcome.detail).toContain('RESEND_API_KEY');
    // The report still exists and is readable; that is the honest thing to say.
    expect(outcome.detail).toContain('readable in Compass');
  });

  it('reports `skipped` when the key is set but the sending address is not', async () => {
    const transport = new ResendEmailTransport({ apiKey: 'test-key' });
    const outcome = await transport.send({
      to: OPTIONS.recipient,
      rendered: renderEmail(renderedReport(), OPTIONS),
      delivery: delivery(),
    });

    expect(outcome.status).toBe('skipped');
    expect(outcome.detail).toContain('COMPASS_EMAIL_FROM');
  });

  it('reports `failed` with the provider status when Resend refuses', async () => {
    const fetchImpl = (async () =>
      new Response('domain is not verified', { status: 403 })) as unknown as typeof fetch;
    const transport = new ResendEmailTransport({ apiKey: 'k', from: 'a@b.test', fetchImpl });

    const outcome = await transport.send({
      to: OPTIONS.recipient,
      rendered: renderEmail(renderedReport(), OPTIONS),
      delivery: delivery(),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('403');
    expect(outcome.error).toContain('domain is not verified');
  });
});
