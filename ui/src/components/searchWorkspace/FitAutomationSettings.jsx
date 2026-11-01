/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useState } from 'react';
import { Button } from '@douyinfe/semi-ui-19';
import { xhrGet, xhrPost, errorMessage } from '../../services/xhr.js';
import { useTranslation } from '../../services/i18n/i18n.jsx';

/** Explicit per-job consent to automatic assessments using the saved personal provider. */
export default function FitAutomationSettings() {
  const t = useTranslation();
  const [value, setValue] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    xhrGet('/api/fit/automation')
      .then(({ json }) => {
        if (active) setValue(json);
      })
      .catch((error) => {
        if (active) {
          setFailed(true);
          setMessage(errorMessage(error, t('search.error')));
        }
      });
    return () => {
      active = false;
    };
  }, [t]);
  const save = async () => {
    setSaving(true);
    try {
      setValue((await xhrPost('/api/fit/automation', { jobIds: value.jobIds })).json);
      setFailed(false);
      setMessage(t('search.saved'));
    } catch (error) {
      setFailed(true);
      setMessage(errorMessage(error, t('search.error')));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="searchWorkspace__card">
      <h2>{t('search.automaticTitle')}</h2>
      <p>{t('search.automaticHelp')}</p>
      {value?.jobs.map((job) => (
        <label key={job.id} className="searchWorkspace__check">
          <input
            type="checkbox"
            checked={value.jobIds.includes(job.id)}
            onChange={(event) => {
              setValue({
                ...value,
                jobIds: event.target.checked ? [...value.jobIds, job.id] : value.jobIds.filter((id) => id !== job.id),
              });
            }}
          />
          {job.name || job.id}
        </label>
      ))}
      {value && !value.jobs.length && <p>{t('search.automaticNoJobs')}</p>}
      <Button onClick={save} disabled={!value} loading={saving}>
        {t('search.automaticSave')}
      </Button>
      <p role={failed ? 'alert' : 'status'}>{message}</p>
    </section>
  );
}
