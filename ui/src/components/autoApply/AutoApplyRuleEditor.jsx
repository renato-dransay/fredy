/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useState } from 'react';
import { Button, InputNumber } from '@douyinfe/semi-ui-19';
import { Link } from 'react-router';
import { saveAutoApplyRule } from '../../services/autoApplyClient.js';
import { errorMessage } from '../../services/xhr.js';
import { useAutoApply } from './useAutoApply.js';
import './AutoApply.less';

/** Whether a connected portal has passed the explicit browser qualification step. */
export function qualifiedConnection(connection) {
  return connection?.qualified === true || connection?.status === 'qualified';
}

/** Build the wire shape without leaking server receipts or worker credentials into a rule update. */
export function editableRule(rule) {
  return {
    enabled: rule?.enabled === true,
    minimumScore: Number.isFinite(rule?.minimumScore) ? rule.minimumScore : 8,
    portals: rule?.portals ?? [],
    documentIds: rule?.documentIds ?? [],
    connectionIds: rule?.connectionIds ?? {},
  };
}

/** Shared per-search rule form. It persists separately from the surrounding search form. */
export function AutoApplyRuleForm({ job, data, reload }) {
  const stored = (data.rules ?? []).find((rule) => rule.jobId === job.id);
  const signature = JSON.stringify(editableRule(stored));
  const [rule, setRule] = useState(() => editableRule(stored));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setRule(JSON.parse(signature));
  }, [signature]);
  const change = (patch) => setRule((previous) => ({ ...previous, ...patch }));
  const toggle = (key, id, selected) =>
    change({ [key]: selected ? [...new Set([...rule[key], id])] : rule[key].filter((value) => value !== id) });
  const ready =
    data.model?.checked === true &&
    rule.portals.length > 0 &&
    rule.portals.every((portal) =>
      (data.connections ?? []).some(
        (connection) =>
          connection.id === rule.connectionIds[portal] &&
          connection.portal === portal &&
          qualifiedConnection(connection),
      ),
    );
  const validScore = Number.isFinite(rule.minimumScore) && rule.minimumScore >= 0 && rule.minimumScore <= 10;
  const save = async () => {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await saveAutoApplyRule(job.id, rule);
      setMessage('Automatic application rule saved.');
      reload();
    } catch (failure) {
      setFailed(true);
      setMessage(errorMessage(failure, 'Unable to save automatic application rule.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="autoApply__card" aria-label={`Automatic applications for ${job.name}`}>
      <h3>{job.name}</h3>
      <div className="autoApply__fields">
        <label className="autoApply__field">
          <span>Minimum known-criteria fit (0–10)</span>
          <InputNumber
            min={0}
            max={10}
            step={0.1}
            precision={1}
            value={rule.minimumScore}
            onChange={(minimumScore) => change({ minimumScore })}
            disabled={busy}
            aria-label="Minimum known-criteria fit"
          />
        </label>
      </div>
      <p className="autoApply__muted">
        Unknown criteria and unresolved locations are allowed. Confirmed must-have failures and search exclusions block
        submission. Only new discoveries and manually added listings from activation onward are considered.
      </p>
      {(data.portals ?? []).map((portal) => (
        <div key={portal.id} className="autoApply__fields">
          <label className="autoApply__check">
            <input
              type="checkbox"
              checked={rule.portals.includes(portal.id)}
              disabled={busy}
              onChange={(event) => toggle('portals', portal.id, event.target.checked)}
            />
            {portal.name}
          </label>
          <label className="autoApply__field">
            <span>{portal.name} browser</span>
            <select
              value={rule.connectionIds[portal.id] ?? ''}
              disabled={busy}
              onChange={(event) =>
                change({ connectionIds: { ...rule.connectionIds, [portal.id]: event.target.value } })
              }
            >
              <option value="">Choose a connected browser</option>
              {(data.connections ?? [])
                .filter((connection) => connection.portal === portal.id && connection.status !== 'revoked')
                .map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name || connection.mode} —{' '}
                    {qualifiedConnection(connection) ? 'login verified' : 'login verification required'}
                  </option>
                ))}
            </select>
          </label>
        </div>
      ))}
      <h4>Documents allowed for this search</h4>
      <p className="autoApply__muted">
        Every selected file may be sent to the advertiser whenever attachments are supported. Select only documents you
        want to share automatically.
      </p>
      {(data.documents ?? []).map((document) => (
        <label className="autoApply__check" key={document.id}>
          <input
            type="checkbox"
            checked={rule.documentIds.includes(document.id)}
            disabled={busy}
            onChange={(event) => toggle('documentIds', document.id, event.target.checked)}
          />
          <span>
            {document.filename}
            {document.description && <span className="autoApply__description">{document.description}</span>}
          </span>
        </label>
      ))}
      {!data.documents?.length && <p>No applicant documents uploaded.</p>}
      <label className="autoApply__check">
        <input
          type="checkbox"
          checked={rule.enabled}
          disabled={busy || (!rule.enabled && !ready)}
          onChange={(event) => change({ enabled: event.target.checked })}
        />
        I authorize paid model assessments and automatic portal submissions using my saved profile, letter and selected
        documents, without approval for each application.
      </label>
      {!ready && (
        <p className="autoApply__muted">
          Check the browser-agent model and qualify a browser for every selected portal before enabling this rule.{' '}
          <Link to="/settings/application">Open Application settings</Link>
        </p>
      )}
      <Button
        htmlType="button"
        theme="solid"
        loading={busy}
        disabled={busy || !validScore || (rule.enabled && !ready)}
        onClick={save}
      >
        Save auto-apply rule
      </Button>
      {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
    </section>
  );
}

/** Embed the owner's rule in an existing search; shared searches never gain editable controls. */
export default function AutoApplyRuleEditor({ jobId }) {
  const { data, error, reload } = useAutoApply();
  const job = data?.jobs?.find((candidate) => candidate.id === jobId);
  return (
    <div className="autoApply">
      {error && <p role="alert">{error}</p>}
      {job && <AutoApplyRuleForm job={job} data={data} reload={reload} />}
    </div>
  );
}
