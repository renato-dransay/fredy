/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useLocale, useTranslation } from '../../services/i18n/i18n.jsx';
import { formatDecimal } from '../../services/number/numberService.js';
import './FitSummary.less';

/**
 * A saved assessment on a ten-point display scale. Stored scores remain percentages for sorting.
 * Failed requirements override the color; unresolved/stale results cannot appear green.
 * Null means unassessed, never a zero score. Secondary statuses are compact chips.
 * Reads only the compact current-user receipt; mounting this component never requests inference.
 * @param {{summary?: {score: number, coverage: number, hardFailure: boolean, hardUnknown: boolean, stale?: boolean}|null}} props
 * @returns {React.ReactElement}
 */
export default function FitSummary({ summary }) {
  const t = useTranslation();
  const locale = useLocale();
  if (!summary || !Number.isFinite(summary.score))
    return (
      <div className="fitSummary fitSummary--empty">
        <span className="fitSummary__chip fitSummary__chip--neutral" title={t('search.summaryNotAssessed')}>
          {t('search.summaryNotAssessed')}
        </span>
      </div>
    );
  const score = Math.round(Math.max(0, Math.min(100, summary.score))) / 10;
  const tone =
    summary.hardFailure || score < 5 ? 'low' : summary.stale || summary.hardUnknown || score < 8 ? 'medium' : 'high';
  return (
    <div className="fitSummary" aria-label={t('search.fitTitle')}>
      <strong className={`fitSummary__score fitSummary__score--${tone}`}>
        {t('search.summaryScore', { value: formatDecimal(score, locale) })}
      </strong>
      <span
        className="fitSummary__chip fitSummary__chip--neutral"
        title={t('search.coverage', { value: Math.round(summary.coverage) })}
      >
        {t('search.coverage', { value: Math.round(summary.coverage) })}
      </span>
      {summary.stale && (
        <span className="fitSummary__chip fitSummary__chip--warning" title={t('search.summaryStale')}>
          {t('search.summaryStale')}
        </span>
      )}
      {summary.hardFailure && (
        <span className="fitSummary__chip fitSummary__chip--failure" title={t('search.summaryFailure')}>
          {t('search.summaryFailure')}
        </span>
      )}
      {summary.hardUnknown && (
        <span className="fitSummary__chip fitSummary__chip--warning" title={t('search.summaryUnknown')}>
          {t('search.summaryUnknown')}
        </span>
      )}
    </div>
  );
}
