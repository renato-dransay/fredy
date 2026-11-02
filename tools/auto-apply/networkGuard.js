/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { createHash } from 'node:crypto';
import { applicationPayload, classifyPortalRequest, submissionMatches } from '../../lib/services/autoApply/portals.js';

/** A one-request write barrier, independent of model instructions and DOM button labels. */
export class WriteBarrier {
  constructor(portal) {
    this.portal = portal;
    this.mode = 'blocked';
    this.intent = null;
    this.attempted = false;
    this.receipt = null;
    this.blocked = null;
    this.documents = [];
    this.uploadReceipts = [];
    this.pendingUploads = new Map();
  }

  /** Human mode is confined to direct user input; no agent/model may run while it is enabled. */
  human(enabled) {
    this.mode = enabled ? 'human' : 'blocked';
    this.intent = null;
  }

  /** Permit selected-document staging only; final message endpoints remain blocked. */
  upload(enabled, documents = []) {
    this.mode = enabled ? 'upload' : 'blocked';
    this.documents = documents;
  }

  /** Arm a fresh authorization; the network barrier consumes it before releasing the matching request. */
  authorize(intent, { expiresAt = Date.now() + 10000, consume = null } = {}) {
    if (this.attempted) throw new Error('submission_already_attempted');
    this.intent = intent;
    this.expiresAt = expiresAt;
    this.consume = consume;
    this.mode = 'submit';
  }

  /** Request bodies are checked locally and never logged or sent back as raw network traces. */
  permits(request) {
    if (this.mode === 'human') return true;
    const kind = classifyPortalRequest(this.portal, request.url, request.method);
    if (kind === 'read') return true;
    // Static third-party assets are needed by portals; cross-origin API and navigation are not.
    if (request.method === 'GET' && ['image', 'stylesheet', 'font', 'script'].includes(request.resourceType)) {
      try {
        return new URL(request.url).protocol === 'https:';
      } catch {
        return false;
      }
    }
    if (kind === 'upload' && this.mode === 'upload') {
      const payload = applicationPayload(request.body);
      const document = this.documents.find((item) => item.filename === payload?.filename);
      if (
        document &&
        typeof payload.fileData === 'string' &&
        createHash('sha256').update(Buffer.from(payload.fileData, 'base64')).digest('hex') === document.hash
      ) {
        this.currentUpload = document;
        return true;
      }
    }
    if (
      kind === 'submission' &&
      this.mode === 'submit' &&
      Date.now() < this.expiresAt &&
      !this.attempted &&
      submissionMatches(this.portal, request, this.intent)
    ) {
      this.attempted = true;
      this.mode = 'blocked';
      this.receipt = { url: request.url, method: request.method, authorized: true, status: null };
      return true;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) this.blocked = 'unsupported_portal_request';
    return false;
  }
}

/**
 * Browser-wide CDP barrier. New pages are paused before their first request, which closes the
 * popup/service-worker escape left by page-only interception. Only the selected application tab
 * may run; the Stagehand extension is trusted runtime and does not receive portal content here.
 */
export async function installBrowserGuard(endpoint, targetId, barrier, onFailure = async () => {}) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  let closed = false;
  const pending = new Map();
  const sessions = new Map();
  let primarySession = null;
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error('browser_guard_closed'));
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('browser_guard_timeout'));
      }, 10000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const attach = async (sessionId, info) => {
    if (info.url.startsWith('chrome-extension://')) {
      await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      return;
    }
    if (info.type !== 'page' || info.targetId !== targetId) {
      await send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
      return;
    }
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    if (primarySession && primarySession !== sessionId) {
      await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      return;
    }
    primarySession = sessionId;
    const installing = (async () => {
      await send('Network.enable', {}, sessionId);
      await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
      await send('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] }, sessionId);
      await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
      await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    })();
    sessions.set(sessionId, installing);
    return installing;
  };
  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error('browser_guard_protocol_error'));
      else request.resolve(message.result);
      return;
    }
    try {
      if (message.method === 'Target.attachedToTarget')
        await attach(message.params.sessionId, message.params.targetInfo);
      if (message.method === 'Fetch.requestPaused') {
        const { request, requestId, resourceType, networkId } = message.params;
        let allowed = barrier.permits({
          url: request.url,
          method: request.method,
          body: request.postData,
          resourceType: resourceType.toLowerCase(),
        });
        if (
          allowed &&
          classifyPortalRequest(barrier.portal, request.url, request.method) === 'submission' &&
          barrier.consume
        ) {
          const consent = await barrier.consume();
          allowed = consent.allowed === true && Date.now() < barrier.expiresAt;
          if (!allowed) barrier.blocked = 'submission_authorization_expired';
        }
        if (
          allowed &&
          barrier.currentUpload &&
          classifyPortalRequest(barrier.portal, request.url, request.method) === 'upload'
        ) {
          barrier.pendingUploads.set(networkId, {
            document: barrier.currentUpload,
            sessionId: message.sessionId,
            status: 0,
          });
          barrier.currentUpload = null;
        }
        if (
          allowed &&
          barrier.receipt?.url === request.url &&
          barrier.receipt?.status == null &&
          request.method === barrier.receipt.method
        )
          barrier.receiptNetworkId = networkId;
        await send(
          allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' },
          message.sessionId,
        );
      }
      if (message.method === 'Network.responseReceived' && barrier.pendingUploads.has(message.params.requestId))
        barrier.pendingUploads.get(message.params.requestId).status = message.params.response.status;
      if (message.method === 'Network.loadingFinished' && barrier.pendingUploads.has(message.params.requestId)) {
        const upload = barrier.pendingUploads.get(message.params.requestId);
        barrier.pendingUploads.delete(message.params.requestId);
        if (upload.status >= 200 && upload.status < 300) {
          const response = await send(
            'Network.getResponseBody',
            { requestId: message.params.requestId },
            upload.sessionId,
          );
          const payload = JSON.parse(
            response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body,
          );
          if (
            typeof payload.attachmentId === 'string' &&
            payload.attachmentId &&
            payload.filename === upload.document.filename &&
            payload.sha256 === upload.document.hash
          )
            barrier.uploadReceipts.push({
              documentId: upload.document.id,
              hash: upload.document.hash,
              attachmentId: payload.attachmentId,
            });
        }
      }
      if (
        message.method === 'Network.responseReceived' &&
        barrier.receipt &&
        message.params.requestId === barrier.receiptNetworkId
      )
        barrier.receipt.status = message.params.response.status;
    } catch {
      barrier.blocked = 'browser_guard_failed';
      socket.close();
    }
  });
  socket.addEventListener('close', () => {
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('browser_guard_closed'));
    }
    pending.clear();
    barrier.mode = 'blocked';
    void onFailure().catch(() => {
      barrier.blocked = 'browser_close_failed';
    });
  });
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  await attach(attached.sessionId, { targetId, type: 'page', url: 'about:blank' });
  await send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: 'page' }, { type: 'service_worker' }, { type: 'shared_worker' }, { type: 'worker' }],
  });
  return {
    close: async () => {
      closed = true;
      socket.close();
    },
    healthy: () => !closed,
  };
}
