/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useState } from 'react';
import { Button } from '@douyinfe/semi-ui-19';
import { useTranslation } from '../../../services/i18n/i18n.jsx';
import { errorMessage } from '../../../services/xhr.js';
import { loadSearchProfile, saveSearchProfile } from '../../../services/searchWorkspaceClient.js';
import { CRITERION_KINDS, criteriaFromDocument } from '../../../services/searchWorkspace.js';
import '../../../components/searchWorkspace/SearchWorkspace.less';
import { CRITERION_ICONS } from '../../../services/listings/criterionPresentation.js';
import FitAutomationSettings from '../../../components/searchWorkspace/FitAutomationSettings.jsx';

/** A document and explicit editable criteria, owned by the signed-in user. */
export default function SearchProfilePage() {
  const t = useTranslation();
  const [profile, setProfile] = useState({ document: '', criteria: [], version: 0 });
  const [provider, setProvider] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    loadSearchProfile()
      .then((value) => {
        if (active) {
          setProfile(value.profile ?? { document: '', criteria: [], version: 0 });
          setProvider(value.provider);
        }
      })
      .catch((error) => {
        if (active) {
          setFailed(true);
          setMessage(errorMessage(error, t('search.error')));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const update = (index, patch) =>
    setProfile((value) => ({
      ...value,
      criteria: value.criteria.map((criterion, i) => (i === index ? { ...criterion, ...patch } : criterion)),
    }));

  const save = async () => {
    setSaving(true);
    setMessage('');
    setFailed(false);
    try {
      const result = await saveSearchProfile({
        document: profile.document,
        criteria: profile.criteria,
        instructions: profile.instructions,
      });
      setProfile(result.profile);
      setProvider(result.provider ?? provider);
      setMessage(t('search.saved'));
    } catch (error) {
      setFailed(true);
      setMessage(errorMessage(error, t('search.error')));
    } finally {
      setSaving(false);
    }
  };

  const upload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 32768 || !/\.(txt|md|markdown)$/i.test(file.name)) throw new Error('document');
      const document = await file.text();
      setProfile((value) => ({ ...value, document }));
      setFailed(false);
      setMessage('');
    } catch {
      setFailed(true);
      setMessage(t('search.documentLimit'));
    }
    event.target.value = '';
  };

  if (loading) return <p role="status">{t('search.loading')}</p>;
  return (
    <div className="searchWorkspace">
      <section className="searchWorkspace__card">
        <h2>{t('search.profileTitle')}</h2>
        <p>{t('search.profileHelp')}</p>
        <div className="searchWorkspace__notice" role="status">
          {provider?.configured ? t('search.providerReady') : t('search.providerMissing')}
        </div>
        {!provider?.configured && <p>{t('search.providerSetup')}</p>}
        <label className="searchWorkspace__field">
          <span>{t('search.document')}</span>
          <textarea
            rows={8}
            maxLength={32768}
            value={profile.document ?? ''}
            onChange={(event) => setProfile({ ...profile, document: event.target.value })}
          />
        </label>
        <div className="searchWorkspace__actions">
          <label>
            {t('search.upload')}{' '}
            <input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={upload} />
          </label>
          <Button
            onClick={() =>
              setProfile({
                ...profile,
                criteria: [...profile.criteria, ...criteriaFromDocument(profile.document)].slice(0, 30),
              })
            }
          >
            {t('search.fromDocument')}
          </Button>
        </div>
        <p className="searchWorkspace__muted">{t('search.documentHelp')}</p>
      </section>
      <section className="searchWorkspace__card">
        <h2>{t('search.instructionsTitle')}</h2>
        <p>{t('search.instructionsHelp')}</p>
        <label className="searchWorkspace__field">
          <span>{t('search.instructionsTitle')}</span>
          <textarea
            rows={6}
            maxLength={4000}
            value={profile.instructions ?? ''}
            onChange={(event) => setProfile({ ...profile, instructions: event.target.value })}
          />
        </label>
        <p className="searchWorkspace__muted">{t('search.instructionsGuard')}</p>
        <div className="searchWorkspace__actions">
          <Button
            theme="solid"
            onClick={save}
            loading={saving}
            disabled={saving || profile.criteria.some((criterion) => !criterion.text.trim())}
          >
            {t('search.saveProfile')}
          </Button>
        </div>
        {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
      </section>
      <section className="searchWorkspace__card">
        <h2>{t('search.criteria')}</h2>
        <p>{t('search.criteriaHelp')}</p>
        {profile.criteria.map((criterion, index) => (
          <div key={criterion.id} className="searchWorkspace__criterion">
            <label className="searchWorkspace__field">
              <span>
                {t('search.criterion')} {index + 1}
              </span>
              <input
                value={criterion.text}
                maxLength={1000}
                onChange={(event) => update(index, { text: event.target.value })}
              />
            </label>
            <div className="searchWorkspace__fields">
              <label className="searchWorkspace__field">
                <span>{t('search.chipLabel')}</span>
                <input
                  maxLength={32}
                  placeholder={t('search.chipAutomatic')}
                  value={criterion.label ?? ''}
                  onChange={(event) => update(index, { label: event.target.value })}
                />
              </label>
              <label className="searchWorkspace__field">
                <span>{t('search.chipIcon')}</span>
                <select value={criterion.icon ?? ''} onChange={(event) => update(index, { icon: event.target.value })}>
                  <option value="">{t('search.chipAutomatic')}</option>
                  {CRITERION_ICONS.map((icon) => (
                    <option key={icon} value={icon}>
                      {t(`search.icon.${icon}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="searchWorkspace__field">
                <span>{t('search.kind')}</span>
                <select
                  value={criterion.kind}
                  onChange={(event) =>
                    update(index, {
                      kind: event.target.value,
                      ...(event.target.value === 'station_line'
                        ? { line: criterion.line || 'U2', maxWalkMinutes: criterion.maxWalkMinutes || 10 }
                        : {}),
                    })
                  }
                >
                  {CRITERION_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`search.kind.${kind}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="searchWorkspace__field">
                <span>{t('search.weight')}</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={criterion.weight}
                  onChange={(event) => update(index, { weight: Number(event.target.value) })}
                />
              </label>
              {['min_rooms', 'min_size', 'max_price'].includes(criterion.kind) && (
                <label className="searchWorkspace__field">
                  <span>{t('search.value')}</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={criterion.value ?? ''}
                    onChange={(event) =>
                      update(index, { value: event.target.value === '' ? undefined : Number(event.target.value) })
                    }
                  />
                </label>
              )}
              {criterion.kind === 'station_line' && (
                <>
                  <label className="searchWorkspace__field">
                    <span>{t('search.line')}</span>
                    <input
                      maxLength={20}
                      value={criterion.line ?? 'U2'}
                      onChange={(event) => update(index, { line: event.target.value })}
                    />
                    <span>{t('search.anySubwayHelp')}</span>
                  </label>
                  <label className="searchWorkspace__field">
                    <span>{t('search.walkMinutes')}</span>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={criterion.maxWalkMinutes ?? 10}
                      onChange={(event) => update(index, { maxWalkMinutes: Number(event.target.value) })}
                    />
                  </label>
                </>
              )}
            </div>
            <div className="searchWorkspace__actions">
              <label className="searchWorkspace__check">
                <input
                  type="checkbox"
                  checked={criterion.required === true}
                  onChange={(event) => update(index, { required: event.target.checked })}
                />
                {t('search.required')}
              </label>
              <Button
                type="danger"
                theme="borderless"
                onClick={() => setProfile({ ...profile, criteria: profile.criteria.filter((_, i) => i !== index) })}
              >
                {t('search.remove')}
              </Button>
            </div>
          </div>
        ))}
        <div className="searchWorkspace__actions">
          <Button
            disabled={profile.criteria.length >= 30}
            onClick={() =>
              setProfile({
                ...profile,
                criteria: [
                  ...profile.criteria,
                  { id: crypto.randomUUID(), text: '', required: false, weight: 1, kind: 'semantic' },
                ],
              })
            }
          >
            {t('search.addCriterion')}
          </Button>
          <Button
            theme="solid"
            onClick={save}
            loading={saving}
            disabled={profile.criteria.some((criterion) => !criterion.text.trim())}
          >
            {t('search.saveProfile')}
          </Button>
        </div>
        <p role={failed ? 'alert' : 'status'} className="searchWorkspace__status">
          {message}
        </p>
      </section>
      <FitAutomationSettings />
    </div>
  );
}
