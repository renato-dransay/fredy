/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { FIT_PIN_SYMBOLS } from './fitPinSymbols.js';
import { MARKER_COLORS } from './markerColors.js';
import { useTranslation } from '../../services/i18n/i18n.jsx';

import './MapLegend.less';

/**
 * What the colours on the map mean.
 *
 * Fit symbols mirror the pins; distance has a separate outline and shared addresses a count.
 *
 * Fit levels are always explained; stack, distance and home entries appear when applicable.
 *
 * @param {Object} props
 * @param {boolean} props.hasStacks
 * @param {boolean} props.hasRing
 * @param {boolean} props.hasHome
 * @returns {React.ReactElement}
 */
export default function MapLegend({ hasStacks, hasRing, hasHome }) {
  const t = useTranslation();

  const entries = [
    ...Object.entries(FIT_PIN_SYMBOLS).map(([key, symbol]) => ({ key, symbol: symbol || '●', show: true })),
    // No colour of its own: the dot takes the badge's text-colour token from the stylesheet, so it
    // is the same as the badge it explains in both themes.
    { key: 'stack', color: null, show: hasStacks },
    { key: 'inRing', show: hasRing },
    { key: 'home', color: MARKER_COLORS.home, show: hasHome },
  ].filter((entry) => entry.show);

  return (
    <div className="mapLegend">
      {entries.map((entry) => (
        <span className="mapLegend__entry" key={entry.key}>
          <span
            className={
              entry.symbol
                ? `mapLegend__symbol mapLegend__symbol--${entry.key}`
                : `mapLegend__dot mapLegend__dot--${entry.key}`
            }
            aria-hidden="true"
            style={entry.color == null ? undefined : { background: entry.color }}
          >
            {entry.symbol}
          </span>
          {t(entry.symbol ? `map.fit.${entry.key}` : `map.legend.${entry.key}`)}
        </span>
      ))}
    </div>
  );
}

MapLegend.displayName = 'MapLegend';
