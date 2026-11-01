/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@douyinfe/semi-ui-19';
import { useTranslation } from '../../services/i18n/i18n.jsx';
import { errorMessage } from '../../services/xhr.js';
import { loadFit, evaluateFit } from '../../services/searchWorkspaceClient.js';
import FitSummary from './FitSummary.jsx';
import './SearchWorkspace.less';

/** Evidence and uncertainty remain visible alongside the conservative fit score. */
export default function FitCard({ listingId, listing }) {
  const t = useTranslation();
  const [state, setState] = useState({ result: null, stale: false });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  // Source refreshes in the same listing page must refresh the stale-result flag as well.
  const evidenceKey = JSON.stringify(
    [
      'title',
      'description',
      'address',
      'price',
      'size',
      'rooms',
      'latitude',
      'longitude',
      'link',
      'provider',
      'charges_included',
      'charges',
    ].map((field) => listing?.[field] ?? null),
  );
  useEffect(() => {
    const token = ++requestId.current;
    setState({ result: null, stale: false });
    setError('');
    setBusy(true);
    loadFit(listingId)
      .then((value) => {
        if (requestId.current === token) setState(value);
      })
      .catch((failure) => {
        if (requestId.current === token) setError(errorMessage(failure, t('search.error')));
      })
      .finally(() => {
        if (requestId.current === token) setBusy(false);
      });
    return () => {
      requestId.current += 1;
    };
  }, [listingId, evidenceKey, t]);

  const assess = async () => {
    const token = ++requestId.current;
    setBusy(true);
    setError('');
    try {
      const value = await evaluateFit(listingId);
      if (requestId.current === token) setState(value);
    } catch (failure) {
      if (requestId.current === token)
        setError(
          failure?.json?.code === 'not_configured'
            ? t('search.providerMissing')
            : errorMessage(failure, t('search.error')),
        );
    } finally {
      if (requestId.current === token) setBusy(false);
    }
  };
  const result = state.result;
  return (
    <section className="listing-card searchWorkspace listing-detail__sec--fit" aria-label={t('search.fitTitle')}>
      <h2 className="listing-card__label">{t('search.fitTitle')}</h2>
      {state.stale && (
        <p role="status" className="searchWorkspace__notice searchWorkspace__notice--warning">
          {t('search.stale')}
        </p>
      )}
      {!result && <p role="status">{t(busy ? 'search.loading' : 'search.noAssessment')}</p>}
      {result && (
        <>
          <FitSummary summary={{ ...result, stale: state.stale }} />
          <p className="searchWorkspace__muted">{t('search.scoreHelp')}</p>
          {result.hardFailure && (
            <div className="searchWorkspace__notice searchWorkspace__notice--error">{t('search.hardFailure')}</div>
          )}
          {result.hardUnknown && (
            <div className="searchWorkspace__notice searchWorkspace__notice--warning">{t('search.hardUnknown')}</div>
          )}
          <details className="searchWorkspace__criterionDetails">
            <summary>{t('search.criterionDetails', { count: result.criteria.length })}</summary>
            {result.criteria.map((criterion) => (
              <div className="searchWorkspace__criterion" key={criterion.id}>
                <strong>{criterion.text}</strong>{' '}
                <span className="searchWorkspace__badge">{t(`search.verdict.${criterion.verdict}`)}</span>
                <p className="searchWorkspace__muted">
                  {criterion.required ? t('search.required') : t('search.preference')} ·{' '}
                  {t('search.confidence', { value: Math.round(criterion.confidence * 100) })}
                </p>
                {(criterion.evidence ?? []).map((evidence, index) => (
                  <p className="searchWorkspace__evidence" key={index}>
                    <strong>{evidence.source}</strong>
                    {' — '}
                    {evidence.text}
                  </p>
                ))}
                {criterion.evidence?.length === 0 && <p>{t('search.noEvidence')}</p>}
              </div>
            ))}
          </details>
          <p className="searchWorkspace__muted">
            {result.model} · {new Date(result.evaluatedAt).toLocaleString()}
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="searchWorkspace__actions">
        <Button onClick={assess} loading={busy} disabled={busy}>
          {t('search.evaluate')}
        </Button>
        <Link to="/settings/search-profile">{t('search.editProfile')}</Link>
      </div>
    </section>
  );
}
