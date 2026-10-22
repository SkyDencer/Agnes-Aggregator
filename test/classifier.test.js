import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUpstreamResponse, classifyNetworkError } from '../src/classifier.js';

test('rule 1: 2xx -> success', () => {
  assert.deepEqual(classifyUpstreamResponse({ status: 200, parsedBody: {} }), {
    action: 'success',
    reason: 'ok',
    retry: false,
  });
  assert.deepEqual(classifyUpstreamResponse({ status: 204, parsedBody: null }), {
    action: 'success',
    reason: 'ok',
    retry: false,
  });
});

test('rule 2: 404 model_not_found -> none, no retry, no penalty', () => {
  const r = classifyUpstreamResponse({
    status: 404,
    parsedBody: { error: { code: 'model_not_found', message: 'Model x not available' } },
  });
  assert.deepEqual(r, { action: 'none', reason: 'model_not_found', retry: false });
});

test('rule 3: 429 -> cooldown', () => {
  assert.deepEqual(classifyUpstreamResponse({ status: 429, parsedBody: { error: {} } }), {
    action: 'cooldown',
    reason: 'rate_limit',
    retry: true,
  });
});

test('rule 4: 401/403 -> disable', () => {
  assert.deepEqual(classifyUpstreamResponse({ status: 401, parsedBody: null }), {
    action: 'disable',
    reason: 'unauthorized',
    retry: true,
  });
  assert.deepEqual(classifyUpstreamResponse({ status: 403, parsedBody: null }), {
    action: 'disable',
    reason: 'unauthorized',
    retry: true,
  });
});

test('rule 5: 5xx -> failure_count', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.deepEqual(classifyUpstreamResponse({ status, parsedBody: null }), {
      action: 'failure_count',
      reason: 'server_error',
      retry: true,
    });
  }
});

test('rule 6: other 4xx -> none / client_error (not the key fault)', () => {
  for (const status of [400, 404, 418, 451]) {
    // 404 without the model_not_found code falls into the generic 4xx rule
    const r = classifyUpstreamResponse({ status, parsedBody: null });
    assert.deepEqual(r, { action: 'none', reason: 'client_error', retry: false });
  }
});

test('rule 7: unknown status -> none / unknown', () => {
  assert.deepEqual(classifyUpstreamResponse({ status: 199, parsedBody: null }), {
    action: 'none',
    reason: 'unknown',
    retry: false,
  });
  assert.deepEqual(classifyUpstreamResponse({ status: 600, parsedBody: null }), {
    action: 'none',
    reason: 'unknown',
    retry: false,
  });
});

test('classifyNetworkError -> failure_count / network_error', () => {
  assert.deepEqual(classifyNetworkError(), {
    action: 'failure_count',
    reason: 'network_error',
    retry: true,
  });
});
