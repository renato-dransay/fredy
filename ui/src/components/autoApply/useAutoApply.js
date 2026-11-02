/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useState } from 'react';
import { loadAutoApply } from '../../services/autoApplyClient.js';
import { errorMessage } from '../../services/xhr.js';
import { subscribeJobEvents } from '../../services/sse/jobEvents.js';

/** Keep private execution state current through shared SSE, with polling for missed events. */
export function useAutoApply() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    loadAutoApply()
      .then((next) => {
        if (active) {
          setData(next);
          setError('');
        }
      })
      .catch((failure) => {
        if (active) {
          // Do not retain private state after session expiry or an access failure.
          if ([401, 403].includes(failure?.status)) setData(null);
          setError(errorMessage(failure, 'Unable to load automatic applications.'));
        }
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    const unsubscribe = subscribeJobEvents('auto-apply', refresh);
    const timer = setInterval(refresh, 15000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  return { data, error, reload: () => setRevision((value) => value + 1) };
}
