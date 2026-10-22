import { classifyUpstreamResponse, classifyNetworkError } from './classifier.js';

const MAX_ATTEMPTS = 3;

// Upstream 429 -> aggregated 429 fallback body (used when the pool is
// exhausted or every attempt hit a retryable error).
export const POOL_EXHAUSTED_BODY = {
  error: {
    message: 'all keys are rate-limited or unavailable; try again later',
    type: 'aggregator_error',
  },
};

// Rotate across the key pool with failover. Non-streaming only (Phase 1).
// Never throws for upstream failures — always returns a result object.
export async function proxyChatCompletion({ store, selector, config, body, clientSignal = null }) {
  // Phase 1 is still non-streaming. Force it regardless of the client.
  if (body && typeof body === 'object' && body.stream === true) {
    body.stream = false;
  }
  const timeoutMs = config.upstreamTimeoutMs ?? 60000;
  const triedIds = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const picked = await selector.selectKey({ exclude: triedIds });
    if (!picked) break; // pool exhausted (all cooling/down/disabled)
    triedIds.push(picked.id);

    let res;
    try {
      res = await fetch(`${config.agnesBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${picked.plaintext}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // network error / timeout — penalize this key, fail over
      await store.recordNetworkError(picked.id, err?.message || 'network error');
      continue;
    }

    let text;
    try {
      text = await res.text();
    } catch (err) {
      await store.recordNetworkError(picked.id, err?.message || 'network error');
      continue;
    }
    // Best-effort parse: Agnes may return non-JSON on some errors.
    let parsedBody;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = { error: { code: 'unknown' } };
    }

    const cls = classifyUpstreamResponse({ status: res.status, parsedBody });

    if (cls.action === 'success') {
      await store.recordSuccess(picked.id, {
        tokens: parsedBody?.usage?.total_tokens ?? 0,
      });
      return { status: res.status, body: parsedBody, key_id: picked.id };
    }

    if (cls.action === 'none') {
      // client error (404 model_not_found, bad 4xx) — count the request on
      // the key but do NOT retry and do NOT penalize beyond that count.
      await store.recordFailure(picked.id, { classifyResult: cls });
      return { status: res.status, body: parsedBody, key_id: picked.id };
    }

    // cooldown / disable / failure_count
    await store.recordFailure(picked.id, { classifyResult: cls });
    if (cls.retry === true) continue;
    return { status: res.status, body: parsedBody, key_id: picked.id };
  }

  // Pool exhausted, or all 3 attempts consumed by retryable errors.
  const retryAfter = await selector.minRemainingCooldownSeconds();
  return {
    status: 429,
    body: POOL_EXHAUSTED_BODY,
    retry_after_seconds: retryAfter || 60,
  };
}
