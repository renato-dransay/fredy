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
import './FitCard.less';

/**
 * Show saved fit criteria as compact pros, cons and unverified chips, without source excerpts.
 * @param {{listingId: string, listing: object}} props Listing and its source-refresh snapshot.
 * @returns {React.ReactElement}
 */
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
    <section
      className="listing-card searchWorkspace fitCard listing-detail__sec--fit"
      aria-label={t('search.fitTitle')}
    >
      <h2 className="listing-card__label">{t('search.fitTitle')}</h2>
      {!result && <p role="status">{t(busy ? 'search.loading' : 'search.noAssessment')}</p>}
      {result && (
        <>
          <FitSummary summary={{ ...result, stale: state.stale }} />
          {['met', 'unmet', 'unknown'].map((verdict) => {
            const criteria = (result.criteria ?? []).filter((criterion) => criterion.verdict === verdict);
            if (!criteria.length) return null;
            return (
              <div className="fitCard__group" key={verdict}>
                <span className="fitCard__groupLabel" id={`fit-${listingId}-${verdict}`}>
                  {t(`search.fitGroup.${verdict}`)}
                </span>
                <ul className="fitCard__chips" aria-labelledby={`fit-${listingId}-${verdict}`}>
                  {criteria.map((criterion) => (
                    <li className={`fitCard__chip fitCard__chip--${verdict}`} key={criterion.id} title={criterion.text}>
                      <span className="fitCard__chipText">{criterion.text}</span>
                      {criterion.required && (
                        <span className="fitCard__required" aria-label={t('search.required')}>
                          *
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="searchWorkspace__actions">
        <Button size="small" onClick={assess} loading={busy} disabled={busy}>
          {t('search.evaluate')}
        </Button>
        <Link to="/settings/search-profile">{t('search.editProfile')}</Link>
      </div>
    </section>
  );
}
