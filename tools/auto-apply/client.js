/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Outbound-only worker client. No cookies, redirects, retries, or credential-bearing error text. */
export function workerClient(baseUrl, token, request = fetch) {
  const base = new URL(baseUrl);
  if (
    base.username ||
    base.password ||
    !['https:', 'http:'].includes(base.protocol) ||
    (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  )
    throw new Error('Use HTTPS or loopback for the Fredy worker endpoint.');
  if (!token || /[\r\n]/.test(token)) throw new Error('A paired worker token is required.');
  const perform = async (path, options = {}) => {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('invalid_worker_path');
    const response = await request(new URL(`/api/applications/worker${path}`, base), {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(path === '/model' ? 60000 : 20000),
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    if (!response.ok) {
      const error = new Error('worker_request_failed');
      error.status = response.status;
      throw error;
    }
    return response;
  };
  return {
    post: async (path, body = {}) =>
      (
        await perform(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json(),
    bytes: async (path, leaseToken) =>
      Buffer.from(await (await perform(path, { headers: { 'x-lease-token': leaseToken } })).arrayBuffer()),
  };
}
