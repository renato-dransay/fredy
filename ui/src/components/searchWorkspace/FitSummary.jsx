/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useTranslation } from '../../services/i18n/i18n.jsx';
import './FitSummary.less';

/**
 * A saved assessment, with uncertainty as visible as the score. Null means unassessed, never 0%.
 * Reads only the compact current-user receipt; mounting this component never requests inference.
 * @param {{summary?: {score: number, coverage: number, hardFailure: boolean, hardUnknown: boolean, stale?: boolean}|null}} props
 * @returns {React.ReactElement}
 */
export default function FitSummary({ summary }) {
  const t = useTranslation();
  if (!summary) return <div className="fitSummary fitSummary--empty">{t('search.summaryNotAssessed')}</div>;
  return (
    <div className="fitSummary" aria-label={t('search.fitTitle')}>
      <strong>{t('search.summaryScore', { value: Math.round(summary.score) })}</strong>
      <span>{t('search.coverage', { value: Math.round(summary.coverage) })}</span>
      {summary.stale && <span className="fitSummary__warning">{t('search.summaryStale')}</span>}
      {summary.hardFailure && <span className="fitSummary__failure">{t('search.summaryFailure')}</span>}
      {summary.hardUnknown && <span className="fitSummary__warning">{t('search.summaryUnknown')}</span>}
    </div>
  );
}
