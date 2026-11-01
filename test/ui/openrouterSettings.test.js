/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the real settings hook without a DOM dependency. Slots retain hook state across
// renders, and effects run after each render, as in the existing useUrlState hook tests.
const h = vi.hoisted(() => ({ slots: [], cursor: 0, effects: [], settings: null, post: vi.fn(), reload: vi.fn() }));
vi.mock('react', () => {
  const changed = (old, deps) => !old || deps.some((value, i) => !Object.is(value, old[i]));
  const memo = (create, deps) => {
    const index = h.cursor++;
    if (changed(h.slots[index]?.deps, deps)) h.slots[index] = { value: create(), deps };
    return h.slots[index].value;
  };
  return {
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useRef: (initial) => {
      const index = h.cursor++;
      return (h.slots[index] ??= { current: initial });
    },
    useState: (initial) => {
      const index = h.cursor++;
      h.slots[index] ??= { value: initial };
      return [
        h.slots[index].value,
        (update) => {
          h.slots[index].value = typeof update === 'function' ? update(h.slots[index].value) : update;
        },
      ];
    },
    useEffect: (effect, deps) => {
      const index = h.cursor++;
      if (changed(h.slots[index], deps)) h.effects.push(effect);
      h.slots[index] = deps;
    },
  };
});
vi.mock('@douyinfe/semi-ui-19', () => ({ Toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../ui/src/services/i18n/i18n.jsx', () => ({ useTranslation: () => (key) => key }));
vi.mock('../../ui/src/services/xhr', () => ({ xhrPost: h.post, errorMessage: () => 'Save failed' }));
vi.mock('../../ui/src/services/state/store.js', () => ({
  useActions: () => ({
    generalSettings: {
      getGeneralSettings: async () => {
        h.settings = { ...h.settings };
      },
    },
  }),
}));

import { useAdminSettings } from '../../ui/src/views/admin/useAdminSettings.js';

/** Render and flush baseline reconciliation, then read the resulting form. */
function render() {
  h.cursor = 0;
  useAdminSettings(h.settings);
  h.effects.splice(0).forEach((effect) => effect());
  h.cursor = 0;
  return useAdminSettings(h.settings);
}

beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.settings = { port: 19998, sqlitepath: '/db', openrouterKeySource: 'settings' };
  h.post.mockReset().mockResolvedValue({});
  vi.stubGlobal('location', { reload: h.reload });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenRouter settings form behavior', () => {
  it('posts a new key and clears the write-only input after a successful save', async () => {
    let view = render();
    expect(view.form.openrouterApiKey).toBe('');
    expect(view.systemDirty).toBe(false);
    view.setField('openrouterApiKey', 'synthetic-new-key');
    view = render();
    expect(view.systemDirty).toBe(true);
    await view.saveSystem();
    const [url, payload] = h.post.mock.lastCall;
    expect(url).toBe('/api/admin/generalSettings');
    expect(payload.openrouterApiKey).toBe('synthetic-new-key');
    expect(payload).not.toHaveProperty('removeOpenrouterApiKey');
    view = render();
    expect(view.form.openrouterApiKey).toBe('');
    expect(view.systemDirty).toBe(false);
  });

  it('discards a removal, and sends explicit null only when removal is saved', async () => {
    let view = render();
    view.setField('removeOpenrouterApiKey', true);
    view = render();
    expect(view.systemDirty).toBe(true);
    view.discardSystem();
    view = render();
    expect(view.form.removeOpenrouterApiKey).toBe(false);
    expect(view.systemDirty).toBe(false);
    view.setField('removeOpenrouterApiKey', true);
    view = render();
    await view.saveSystem();
    expect(h.post.mock.lastCall[1].openrouterApiKey).toBeNull();
    view = render();
    expect(view.form.removeOpenrouterApiKey).toBe(false);
    expect(view.systemDirty).toBe(false);
  });

  it('retains edits after a rejected save so an admin can correct or discard them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.post.mockRejectedValue({ status: 400, json: { error: 'Invalid key' } });
    let view = render();
    view.setField('openrouterApiKey', 'synthetic bad key');
    view = render();
    await view.saveSystem();
    view = render();
    expect(view.form.openrouterApiKey).toBe('synthetic bad key');
    expect(view.systemDirty).toBe(true);
    expect(view.savingSystem).toBe(false);
    view.discardSystem();
    expect(render().form.openrouterApiKey).toBe('');
  });
});
