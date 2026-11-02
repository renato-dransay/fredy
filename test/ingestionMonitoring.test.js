/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi } from 'vitest';
import { mockFredy } from './utils.js';

const extractorResult = vi.hoisted(() => ({ body: null, listings: null }));
vi.mock('../lib/services/extractor/extractor.js', () => ({
  default: class {
    constructor() {
      this.responseText = extractorResult.body;
    }
    async execute() {}
    parseResponseText() {
      return extractorResult.listings;
    }
  },
}));

/** Real pipeline handling, with outbound side effects replaced by the existing fixture harness. */
async function pipeline(getListings) {
  const Fredy = await mockFredy();
  const monitor = Object.fromEntries(
    ['stage', 'count', 'warning', 'incomplete', 'failed', 'noNew', 'finish'].map((key) => [key, vi.fn()]),
  );
  const config = { url: 'https://example.com/search', getListings, normalize: (item) => item, filter: () => true };
  return {
    monitor,
    fredy: new Fredy(config, { id: 'monitor-job', notificationAdapter: [] }, 'test-provider', {}, null, { monitor }),
  };
}

describe('pipeline monitoring', () => {
  it('reports a thrown search error despite execute historically swallowing it', async () => {
    const error = new Error('network request failed');
    const { fredy, monitor } = await pipeline(async () => {
      throw error;
    });
    await expect(fredy.execute()).resolves.toBeUndefined();
    expect(monitor.stage).toHaveBeenLastCalledWith('fetch');
    expect(monitor.failed).toHaveBeenCalledWith(error);
    expect(monitor.noNew).not.toHaveBeenCalled();
  });

  it('marks an ordinary empty result as no-new, not failed', async () => {
    const { fredy, monitor } = await pipeline(async () => []);
    await fredy.execute();
    expect(monitor.count).toHaveBeenCalledWith('fetched', 0);
    expect(monitor.noNew).toHaveBeenCalledOnce();
    expect(monitor.failed).not.toHaveBeenCalled();
  });

  it('marks provider-reported incomplete results before the no-new short circuit', async () => {
    const partial = Object.defineProperties([], {
      ingestionIncomplete: { value: true },
      ingestionHttpStatus: { value: 403 },
    });
    const { fredy, monitor } = await pipeline(async () => partial);
    await fredy.execute();
    expect(monitor.incomplete).toHaveBeenCalledWith(403);
    expect(monitor.incomplete.mock.invocationCallOrder[0]).toBeLessThan(monitor.noNew.mock.invocationCallOrder[0]);
  });

  it('does not disguise a swallowed extractor failure as a healthy empty result', async () => {
    extractorResult.body = null;
    const { fredy, monitor } = await pipeline(undefined);
    await fredy.execute();
    expect(monitor.incomplete).toHaveBeenCalledOnce();
  });

  it('marks loaded pages without matching cards as uncertain rather than confirmed healthy empty', async () => {
    extractorResult.body = '<html>Changed layout or an empty search</html>';
    extractorResult.listings = null;
    const { fredy, monitor } = await pipeline(undefined);
    await fredy.execute();
    expect(monitor.warning).toHaveBeenCalledOnce();
    expect(monitor.incomplete).not.toHaveBeenCalled();
    expect(monitor.noNew).toHaveBeenCalledOnce();
  });

  it('records failure at the actual later failing stage', async () => {
    const { fredy, monitor } = await pipeline(async () => [{ id: 'x' }]);
    const error = new Error('normalization failed');
    fredy._normalize = () => {
      throw error;
    };
    await fredy.execute();
    expect(monitor.stage).toHaveBeenLastCalledWith('normalize');
    expect(monitor.failed).toHaveBeenCalledWith(error);
  });
});
