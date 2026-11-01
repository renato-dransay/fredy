/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useSyncExternalStore } from 'react';
import { useLocale } from '../../services/i18n/i18n.jsx';
import {
  getExclusivityTime,
  getServerExclusivityTime,
  readExclusivity,
  subscribeToExclusivityTime,
} from '../../services/listings/exclusivity.js';
import { format } from '../../services/time/timeService.js';
import './ExclusiveBadge.less';

/**
 * The portal's membership restriction, including its deadline when supplied. The shared clock
 * removes expired badges while a listings page stays open, without waiting for a data refresh.
 *
 * @param {{listing: Object|null}} props A row from the listings API.
 * @returns {React.ReactElement|null}
 */
export default function ExclusiveBadge({ listing }) {
  const locale = useLocale();
  const now = useSyncExternalStore(subscribeToExclusivityTime, getExclusivityTime, getServerExclusivityTime);
  const exclusive = readExclusivity(listing, now);
  if (!exclusive) return null;

  return (
    <span className="exclusiveBadge">
      <span>{exclusive.label}</span>
      {exclusive.until != null && (
        <>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(exclusive.until).toISOString()}>{format(exclusive.until, false, locale)}</time>
        </>
      )}
    </span>
  );
}
