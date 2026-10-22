// Classify an upstream Agnes response into a rotation action.
// Order matters — first matching rule wins.
export function classifyUpstreamResponse({ status, parsedBody }) {
  if (status >= 200 && status < 300) {
    return { action: 'success', reason: 'ok', retry: false };
  }
  // Real-API finding (Phase 0.5): 404 model_not_found is a client/model
  // problem, not a key problem. No retry, no penalty.
  if (status === 404 && parsedBody?.error?.code === 'model_not_found') {
    return { action: 'none', reason: 'model_not_found', retry: false };
  }
  if (status === 429) {
    return { action: 'cooldown', reason: 'rate_limit', retry: true };
  }
  if (status === 401 || status === 403) {
    return { action: 'disable', reason: 'unauthorized', retry: true };
  }
  if (status >= 500 && status < 600) {
    return { action: 'failure_count', reason: 'server_error', retry: true };
  }
  if (status >= 400 && status < 500) {
    // any other 4xx: client sent a bad request — not the key's fault
    return { action: 'none', reason: 'client_error', retry: false };
  }
  return { action: 'none', reason: 'unknown', retry: false };
}

export function classifyNetworkError() {
  return { action: 'failure_count', reason: 'network_error', retry: true };
}
