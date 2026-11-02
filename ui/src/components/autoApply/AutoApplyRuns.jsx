/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@douyinfe/semi-ui-19';
import { controlAutoApplyBrowser, controlAutoApplyRun } from '../../services/autoApplyClient.js';
import { errorMessage } from '../../services/xhr.js';
import { useAutoApply } from './useAutoApply.js';
import AutoApplyBrowser from './AutoApplyBrowser.jsx';
import './AutoApply.less';

const LABELS = {
  pending_assessment: 'Waiting for assessment',
  queued: 'Queued',
  running: 'Applying',
  needs_input: 'Your input needed',
  submitting: 'Submission in progress',
  submitted: 'Submitted',
  uncertain: 'Submission outcome uncertain',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

/** Private execution receipt and explicit intervention controls for one application attempt. */
function RunCard({ run, data, reload, openBrowser }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [evidence, setEvidence] = useState('');
  const control = async (action, details) => {
    setBusy(true);
    setMessage('');
    try {
      await controlAutoApplyRun(run.id, action, details);
      reload();
    } catch (failure) {
      setMessage(errorMessage(failure, 'Unable to update this automatic application.'));
    } finally {
      setBusy(false);
    }
  };
  const connection = (data.connections ?? []).find((item) => item.id === run.connectionId);
  const receipt = run.receipt;
  const snapshot = run.snapshot;
  return (
    <li className="autoApply__card">
      <div className="autoApply__actions">
        {run.listingId ? (
          <Link to={`/listings/listing/${encodeURIComponent(run.listingId)}`}>
            {run.title || snapshot?.listing?.title || run.listingId}
          </Link>
        ) : (
          <strong>Removed listing</strong>
        )}
        <strong>{LABELS[run.state] || run.state}</strong>
        <span>{run.portal}</span>
      </div>
      {run.reason && <p>{String(run.reason).replaceAll('_', ' ')}</p>}
      {run.updatedAt && <p className="autoApply__muted">Updated {new Date(run.updatedAt).toLocaleString()}</p>}
      {run.usage && (
        <p className="autoApply__muted">
          Model: {run.usage.model} · {run.usage.inputTokens ?? 0} input tokens · {run.usage.outputTokens ?? 0} output
          tokens
          {Number.isFinite(run.usage.cost) && ` · $${run.usage.cost.toFixed(4)} reported cost`}
        </p>
      )}
      {(snapshot || receipt) && (
        <details>
          <summary>Application content and receipt</summary>
          {snapshot?.accountIdentity && <p>Portal account: {snapshot.accountIdentity}</p>}
          {snapshot?.message && (
            <>
              <h4>Message</h4>
              <pre className="autoApply__receipt">{snapshot.message}</pre>
            </>
          )}
          {snapshot?.answers && (
            <>
              <h4>Form answers</h4>
              <dl>
                {Object.entries(snapshot.answers).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {!!snapshot?.documents?.length && (
            <>
              <h4>Applicant documents</h4>
              <ul>
                {snapshot.documents.map((document) => (
                  <li key={document.id}>
                    {document.filename}
                    <small className="autoApply__muted"> · {document.hash}</small>
                  </li>
                ))}
              </ul>
            </>
          )}
          {snapshot?.attachmentsSupported === false && (
            <p>This portal form did not support attachments. No documents were sent.</p>
          )}
          {receipt?.confirmationText && (
            <>
              <h4>Portal confirmation</h4>
              <p>{receipt.confirmationText}</p>
            </>
          )}
          {receipt?.url && <p className="autoApply__muted">Confirmation page: {receipt.url}</p>}
        </details>
      )}
      <div className="autoApply__actions">
        {['pending_assessment', 'queued', 'running'].includes(run.state) && (
          <Button disabled={busy} onClick={() => control('pause')}>
            Pause
          </Button>
        )}
        {run.state === 'needs_input' && (
          <Button disabled={busy} onClick={() => control('resume')}>
            Resume
          </Button>
        )}
        {['pending_assessment', 'queued', 'running', 'needs_input', 'failed'].includes(run.state) && (
          <Button disabled={busy} onClick={() => control('cancel')}>
            Cancel
          </Button>
        )}
        {connection && ['needs_input', 'uncertain'].includes(run.state) && (
          <Button disabled={busy} onClick={() => openBrowser(connection)}>
            Open browser
          </Button>
        )}
      </div>
      {run.state === 'uncertain' && (
        <div>
          <p>
            Check the portal's sent-message or application history before resolving this outcome. An uncertain
            application is never automatically resent.
          </p>
          <label className="autoApply__field">
            <span>Portal confirmation or history evidence</span>
            <input
              type="text"
              value={evidence}
              maxLength={2000}
              onChange={(event) => setEvidence(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="autoApply__actions">
            <Button
              disabled={busy || !evidence.trim()}
              onClick={() => control('reconcile', { outcome: 'submitted', confirmationText: evidence.trim() })}
            >
              Confirmed submitted
            </Button>
            <Button
              disabled={busy || !evidence.trim()}
              onClick={() => control('reconcile', { outcome: 'not_submitted', confirmationText: evidence.trim() })}
            >
              Confirmed not submitted
            </Button>
          </div>
        </div>
      )}
      {message && <p role="alert">{message}</p>}
    </li>
  );
}

/** Show all private runs, or only the attempts attached to the current listing. */
export default function AutoApplyRuns({ listingId = null }) {
  const { data, error, reload } = useAutoApply();
  const [browser, setBrowser] = useState(null);
  const [message, setMessage] = useState('');
  const runs = (data?.runs ?? []).filter((run) => !listingId || run.listingId === listingId);
  const openBrowser = async (connection) => {
    setMessage('');
    try {
      await controlAutoApplyBrowser(connection.id, 'open');
      setBrowser(connection);
      reload();
    } catch (failure) {
      setMessage(errorMessage(failure, 'Unable to open the portal browser.'));
    }
  };
  return (
    <section className="autoApply" aria-label="Automatic application progress">
      <div className="autoApply__actions">
        <h2>Automatic applications</h2>
        <Link to="/settings/application">Configure auto-apply</Link>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="alert">{message}</p>}
      {!data && !error && <p role="status">Loading automatic applications…</p>}
      {data?.draining && <p role="status">Automatic applications are paused for a service update.</p>}
      {data && runs.length === 0 && <p>No automatic application attempts{listingId ? ' for this listing' : ' yet'}.</p>}
      <ul className="autoApply__list">
        {runs.map((run) => (
          <RunCard key={run.id} run={run} data={data} reload={reload} openBrowser={openBrowser} />
        ))}
      </ul>
      {browser && (
        <AutoApplyBrowser
          key={browser.id}
          connection={data.connections?.find((connection) => connection.id === browser.id) ?? browser}
          onClose={() => setBrowser(null)}
          reload={reload}
        />
      )}
    </section>
  );
}
