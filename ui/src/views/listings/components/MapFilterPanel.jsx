/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useState } from 'react';
import { Badge } from '@douyinfe/semi-ui-19';
import { IconChevronDown } from '@douyinfe/semi-icons';

/**
 * Collapsible listing filters, with fullscreen and legend accessible in either state.
 * Hidden children are unmounted so controls such as the price slider measure their visible
 * width on opening. An optional nonfoldable mode is retained for callers needing a fixed panel.
 *
 * @param {Object} props
 * @param {boolean} props.foldable - Whether to fold at all. False renders the panel open.
 * @param {string} props.title - The heading and toggle label.
 * @param {number} [props.activeCount=0] - How many filters are hiding pins, shown while folded.
 * @param {string} [props.activeCountLabel] - The same count in words, for a screen reader.
 * @param {React.ReactNode} [props.headerExtra] - The end of the heading row, folded or not.
 * @param {React.ReactNode} [props.footer] Independently accessible legend, even with filters folded.
 * @param {React.ReactNode} props.children - Everything below the heading.
 * @returns {React.ReactElement}
 */
export default function MapFilterPanel({
  foldable,
  title,
  activeCount = 0,
  activeCountLabel,
  headerExtra = null,
  footer = null,
  children,
}) {
  const [open, setOpen] = useState(false);
  const folded = foldable && !open;
  // Only while folded: opened, the filters are on screen and speak for themselves.
  const showCount = folded && activeCount > 0;

  return (
    <div className={folded ? 'map-panel map-panel--folded' : 'map-panel'}>
      <div className="map-panel__groupTitle">
        {foldable ? (
          <button
            type="button"
            className="map-panel__foldToggle"
            aria-expanded={open}
            aria-label={showCount ? `${title}, ${activeCountLabel}` : undefined}
            onClick={() => setOpen((current) => !current)}
          >
            {title}
            {showCount && <Badge count={activeCount} type="primary" />}
            <IconChevronDown className="map-panel__foldChevron" aria-hidden />
          </button>
        ) : (
          title
        )}
        {headerExtra}
      </div>
      {!folded && children}
      {footer}
    </div>
  );
}
