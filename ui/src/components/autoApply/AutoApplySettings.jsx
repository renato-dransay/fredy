/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useState } from 'react';
import { Button } from '@douyinfe/semi-ui-19';
import {
  checkAutoApplyModel,
  connectAutoApplyBrowser,
  controlAutoApplyBrowser,
  saveAutoApplyModel,
} from '../../services/autoApplyClient.js';
import { errorMessage } from '../../services/xhr.js';
import { useAutoApply } from './useAutoApply.js';
import { AutoApplyRuleForm, qualifiedConnection } from './AutoApplyRuleEditor.jsx';
import AutoApplyBrowser from './AutoApplyBrowser.jsx';
import ApplicantDocuments from './ApplicantDocuments.jsx';
import './AutoApply.less';

/** Private setup for browser workers, applicant documents and per-search authorization. */
export default function AutoApplySettings() {
  const { data, error, reload } = useAutoApply();
  const [model, setModel] = useState('');
  const [portal, setPortal] = useState('immoscout');
  const [mode, setMode] = useState('server');
  const [name, setName] = useState('');
  const [pairing, setPairing] = useState(null);
  const [browser, setBrowser] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setModel(data?.model?.model ?? '');
  }, [data?.model?.model]);
  const run = async (action, success = 'Saved.') => {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await action();
      setMessage(success);
      reload();
    } catch (failure) {
      setFailed(true);
      setMessage(
        errorMessage(failure, failure instanceof Error ? failure.message : 'Automatic application setup failed.'),
      );
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    run(async () => {
      const result = await connectAutoApplyBrowser({ portal, mode, name: name.trim() || `${portal} ${mode}` });
      setPairing(result);
      setName('');
    }, 'Browser connection created. Start its worker, then sign in and qualify the portal.');
  const open = (connection) =>
    run(async () => {
      await controlAutoApplyBrowser(connection.id, 'open');
      setBrowser(connection);
    }, 'Browser opened in human control.');
  return (
    <section className="autoApply" aria-label="Automatic application settings">
      <h2>Automatic applications</h2>
      <p>
        Apply in a signed-in portal browser using your saved applicant profile and letter. Rules are disabled until you
        explicitly enable them.
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading automatic application settings…</p>}
      {data && (
        <>
          {data.draining && <p role="status">Applications are paused while the service is being updated.</p>}
          <section className="autoApply__card">
            <h3>Browser-agent model</h3>
            <p className="autoApply__muted">
              Uses the personal OpenRouter credential configured by the administrator. This model is separate from JEV
              assessment. Checking it makes a small paid request.
            </p>
            <label className="autoApply__field">
              <span>OpenRouter model identifier</span>
              <input
                type="text"
                value={model}
                maxLength={200}
                disabled={busy}
                placeholder="provider/model"
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            <div className="autoApply__actions">
              <Button
                disabled={busy || !model.trim()}
                onClick={() =>
                  run(() => saveAutoApplyModel(model.trim()), 'Model saved. Check it before enabling a rule.')
                }
              >
                Save model
              </Button>
              <Button
                disabled={busy || !data.model?.model || model !== data.model.model}
                onClick={() => run(checkAutoApplyModel, 'Model configuration checked.')}
              >
                Check model
              </Button>
              <span>{data.model?.checked ? 'Configuration checked' : 'Configuration check required'}</span>
            </div>
          </section>
          <section className="autoApply__card">
            <h3>Portal browsers</h3>
            <p className="autoApply__muted">
              Sign in directly in an isolated browser. Server mode can run while your laptop is closed; desktop mode
              waits for your paired computer. Verify the portal login before enabling a rule. Unsupported application
              forms pause for intervention.
            </p>
            <div className="autoApply__fields">
              <label className="autoApply__field">
                <span>Portal</span>
                <select value={portal} onChange={(event) => setPortal(event.target.value)} disabled={busy}>
                  {(data.portals ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="autoApply__field">
                <span>Browser location</span>
                <select value={mode} onChange={(event) => setMode(event.target.value)} disabled={busy}>
                  <option value="server">Dedicated server browser</option>
                  <option value="desktop">Paired desktop browser</option>
                </select>
              </label>
              <label className="autoApply__field">
                <span>Connection name</span>
                <input
                  type="text"
                  value={name}
                  maxLength={100}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            </div>
            <Button disabled={busy} onClick={connect}>
              Connect portal
            </Button>
            {pairing?.token && (
              <div className="autoApply__card" role="status">
                <h4>One-time worker credential</h4>
                <p>
                  Configure the worker with this credential. It will not be shown again. Keep it private and out of
                  logs.
                </p>
                <label className="autoApply__field">
                  <span>Pairing credential</span>
                  <input
                    type="password"
                    readOnly
                    value={pairing.token}
                    autoComplete="off"
                    onFocus={(event) => event.target.select()}
                  />
                </label>
                <p>Connection: {pairing.connection?.id}</p>
                <Button onClick={() => setPairing(null)}>Dismiss credential</Button>
              </div>
            )}
            <ul className="autoApply__list">
              {(data.connections ?? []).map((connection) => (
                <li className="autoApply__card" key={connection.id}>
                  <strong>{connection.name || connection.portal}</strong> · {connection.portal} · {connection.mode}
                  <p>
                    {qualifiedConnection(connection)
                      ? 'Login verified'
                      : 'Unavailable for auto-apply — login verification required'}{' '}
                    · {connection.status}
                  </p>
                  {connection.accountIdentity && <p>Portal account: {connection.accountIdentity}</p>}
                  {connection.status !== 'revoked' && (
                    <div className="autoApply__actions">
                      <Button disabled={busy} onClick={() => open(connection)}>
                        Open browser
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => run(() => controlAutoApplyBrowser(connection.id, 'pause'), 'Browser paused.')}
                      >
                        Pause
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => run(() => controlAutoApplyBrowser(connection.id, 'resume'), 'Browser resumed.')}
                      >
                        Resume
                      </Button>
                      <Button
                        disabled={busy}
                        type="danger"
                        onClick={() =>
                          run(async () => {
                            await controlAutoApplyBrowser(connection.id, 'revoke');
                            if (browser?.id === connection.id) setBrowser(null);
                          }, 'Browser credential revoked.')
                        }
                      >
                        Revoke
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
          {browser && (
            <AutoApplyBrowser
              key={browser.id}
              connection={data.connections?.find((connection) => connection.id === browser.id) ?? browser}
              onClose={() => setBrowser(null)}
              reload={reload}
            />
          )}
          <ApplicantDocuments documents={data.documents ?? []} busy={busy} run={run} />
          <h3>Search rules</h3>
          {!data.jobs?.length && <p>Create a search you own before configuring automatic applications.</p>}
          {(data.jobs ?? []).map((job) => (
            <AutoApplyRuleForm key={job.id} job={job} data={data} reload={reload} />
          ))}
        </>
      )}
      {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
    </section>
  );
}
