/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useState } from 'react';
import { Button } from '@douyinfe/semi-ui-19';
import {
  autoApplyBrowserFrame,
  autoApplyBrowserInput,
  controlAutoApplyBrowser,
} from '../../services/autoApplyClient.js';
import { errorMessage } from '../../services/xhr.js';
import './AutoApply.less';

/** Convert a displayed screenshot position into the browser viewport without CSS scaling errors. */
export function browserPoint(event) {
  const image = event.currentTarget;
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const x = Math.floor((event.clientX - bounds.left) / scale);
  const y = Math.floor((event.clientY - bounds.top) / scale);
  return x >= 0 && y >= 0 && x < image.naturalWidth && y < image.naturalHeight ? { x, y } : null;
}

/** Human-only browser view. Opening it suspends agent control until the user explicitly resumes. */
export default function AutoApplyBrowser({ connection, onClose, reload }) {
  const [frame, setFrame] = useState(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [key, setKey] = useState('Tab');
  const [accountIdentity, setAccountIdentity] = useState(connection.accountIdentity ?? '');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let fetching = false;
    const fetchFrame = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const next = await autoApplyBrowserFrame(connection.id);
        if (active) {
          setFrame(next);
          setError('');
        }
      } catch (failure) {
        if (active) {
          setFrame(null);
          setError(errorMessage(failure, 'Browser is not connected. Start the paired worker and try again.'));
        }
      } finally {
        fetching = false;
      }
    };
    void fetchFrame();
    const timer = setInterval(fetchFrame, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connection.id, revision]);
  const input = async (value) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await autoApplyBrowserInput(connection.id, value);
      if (value.type === 'verify_login')
        setStatus(
          'Checking login persistence. The worker will reopen this browser and verify your account before it becomes available for auto-apply.',
        );
      setRevision((current) => current + 1);
    } catch (failure) {
      setError(errorMessage(failure, 'Browser action failed.'));
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    setBusy(true);
    try {
      await controlAutoApplyBrowser(connection.id, 'resume');
      reload();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, 'Unable to resume the browser.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="autoApply__card" aria-label="Portal browser">
      <h3>{connection.name || connection.portal} — human control</h3>
      <p>The agent is paused. Sign in directly on the portal, complete any challenge, then resume.</p>
      <p className="autoApply__muted">{frame?.url || 'Waiting for the paired browser…'}</p>
      {frame?.imageBase64 && (
        <img
          className="autoApply__frame"
          src={`data:${frame.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'};base64,${frame.imageBase64}`}
          alt="Current portal browser. Click a field, then use the text or keyboard controls below."
          onClick={(event) => {
            const point = browserPoint(event);
            if (point) void input({ type: 'click', ...point });
          }}
        />
      )}
      <div className="autoApply__fields">
        <label className="autoApply__field">
          <span>Text for the focused field (hidden)</span>
          <input
            type="password"
            autoComplete="off"
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
          />
        </label>
        <label className="autoApply__field">
          <span>Keyboard key</span>
          <select value={key} onChange={(event) => setKey(event.target.value)} disabled={busy}>
            {['Tab', 'Enter', 'Backspace', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="autoApply__actions">
        <Button disabled={busy} onClick={() => input({ type: 'navigate' })}>
          Portal home
        </Button>
        <Button
          disabled={busy || !text}
          onClick={() => {
            const value = text;
            setText('');
            void input({ type: 'type', text: value });
          }}
        >
          Type text
        </Button>
        <Button disabled={busy} onClick={() => input({ type: 'key', key })}>
          Press {key}
        </Button>
        <Button disabled={busy} onClick={() => input({ type: 'scroll', x: 400, y: 300, deltaY: -600 })}>
          Scroll up
        </Button>
        <Button disabled={busy} onClick={() => input({ type: 'scroll', x: 400, y: 300, deltaY: 600 })}>
          Scroll down
        </Button>
        <Button disabled={busy} theme="solid" onClick={resume}>
          Resume agent
        </Button>
        <Button disabled={busy} onClick={onClose}>
          Close view (keep paused)
        </Button>
      </div>
      <div className="autoApply__fields">
        <label className="autoApply__field">
          <span>Account email or name visible on the portal</span>
          <input
            type="text"
            value={accountIdentity}
            maxLength={320}
            disabled={busy}
            onChange={(event) => setAccountIdentity(event.target.value)}
            autoComplete="off"
          />
        </label>
      </div>
      <p className="autoApply__muted">
        After signing in, verify that this account stays signed in when the worker reopens its browser. This does not
        submit an application.
      </p>
      <Button
        disabled={busy || !accountIdentity.trim()}
        onClick={() => input({ type: 'verify_login', accountIdentity: accountIdentity.trim() })}
      >
        Verify login
      </Button>
      <p role="status">{connection.qualified ? 'Login verified.' : 'Login verification required.'}</p>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
