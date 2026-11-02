/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useLocale, useTranslation } from '../../services/i18n/i18n.jsx';
import { formatDecimal } from '../../services/number/numberService.js';
import './FitSummary.less';
import { fitTone } from '../../services/listings/fitPresentation.js';

/**
 * A saved assessment on a ten-point display scale. Stored scores remain percentages for sorting.
 * Failed requirements override the color; stale results cannot appear green.
 * A null summary means unassessed; a null score means no known criteria. Neither is a zero score.
 * Reads only the compact current-user receipt; mounting this component never requests inference.
 * @param {{summary?: {score: number|null, coverage: number, hardFailure: boolean, hardUnknown: boolean, stale?: boolean}|null}} props
 * @param {boolean} [props.compact=false] Collapse secondary statuses in repeated result cards.
 * @returns {React.ReactElement}
 */
export default function FitSummary({ summary, compact = false }) {
  const t = useTranslation();
  const locale = useLocale();
  if (!summary)
    return (
      <div className="fitSummary fitSummary--empty">
        <span className="fitSummary__chip fitSummary__chip--neutral" title={t('search.summaryNotAssessed')}>
          {t('search.summaryNotAssessed')}
        </span>
      </div>
    );
  const score = Number.isFinite(summary.score) ? Math.round(Math.max(0, Math.min(100, summary.score))) / 10 : null;
  const scoreLabel =
    score === null ? t('search.summaryNoKnown') : t('search.summaryScore', { value: formatDecimal(score, locale) });
  const tone = fitTone(summary);
  const scoreElement = <strong className={`fitSummary__score fitSummary__score--${tone}`}>{scoreLabel}</strong>;
  const statuses = [
    t('search.coverage', { value: Math.round(summary.coverage) }),
    summary.stale && t('search.summaryStale'),
    summary.hardFailure && t('search.summaryFailure'),
    summary.hardUnknown && t('search.summaryUnknown'),
  ].filter(Boolean);
  if (compact)
    return (
      <details className="fitSummary fitSummary--compact" onClick={(event) => event.stopPropagation()}>
        <summary
          className="fitSummary__toggle"
          aria-label={`${t('search.fitTitle')}: ${scoreLabel}; ${statuses.join('; ')}`}
        >
          <span>JEV</span>
          {scoreElement}
          {(summary.stale || summary.hardFailure || summary.hardUnknown) && (
            <span className={`fitSummary__signal fitSummary__signal--${tone}`} aria-hidden="true">
              !
            </span>
          )}
          <span className="fitSummary__chevron" aria-hidden="true">
            ⌄
          </span>
        </summary>
        <div className="fitSummary__details">
          {statuses.map((status) => (
            <span key={status}>{status}</span>
          ))}
        </div>
      </details>
    );
  return (
    <div className="fitSummary" aria-label={t('search.fitTitle')}>
      <strong className={`fitSummary__score fitSummary__score--${tone}`}>{scoreLabel}</strong>
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
