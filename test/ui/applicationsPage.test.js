/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Retain hook state and exercise the page's actual controls, following the settings hook tests.
const h = vi.hoisted(() => ({
  slots: [],
  cursor: 0,
  effects: [],
  load: vi.fn(),
  save: vi.fn(),
  loadOne: vi.fn(),
  addEvent: vi.fn(),
  letter: vi.fn(),
  listener: null,
  t: (key) => key,
}));
vi.mock('react', () => ({
  useRef: (initial) => {
    const index = h.cursor++;
    return (h.slots[index] ??= { current: initial });
  },
  useState: (initial) => {
    const index = h.cursor++;
    h.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [
      h.slots[index].value,
      (update) => {
        h.slots[index].value = typeof update === 'function' ? update(h.slots[index].value) : update;
      },
    ];
  },
  useEffect: (effect, deps) => {
    const index = h.cursor++;
    if (!h.slots[index] || deps.some((value, i) => !Object.is(value, h.slots[index][i]))) h.effects.push(effect);
    h.slots[index] = deps;
  },
}));
vi.mock('@douyinfe/semi-ui-19', () => ({ Button: 'button' }));
vi.mock('../../ui/src/services/applicationClient.js', () => ({ fetchApplicationLetter: h.letter }));
vi.mock('react-router', () => ({ Link: 'a' }));
vi.mock('../../ui/src/services/sse/jobEvents.js', () => ({
  subscribeJobEvents: (_event, handler) => {
    h.listener = handler;
    return () => {};
  },
}));
vi.mock('../../ui/src/components/headline/Headline.jsx', () => ({ default: 'header' }));
vi.mock('../../ui/src/services/i18n/i18n.jsx', () => ({ useTranslation: () => h.t }));
vi.mock('../../ui/src/services/searchWorkspaceClient.js', () => ({
  loadApplications: h.load,
  saveApplication: h.save,
  loadApplication: h.loadOne,
  addApplicationEvent: h.addEvent,
  visitCalendarUrl: (id) => `/api/applications/listings/${id}/visit.ics`,
}));

import ApplicationsPage from '../../ui/src/views/applications/ApplicationsPage.jsx';
import ApplicationTracker from '../../ui/src/components/searchWorkspace/ApplicationTracker.jsx';

/** Read JSX nodes after a render; event handlers are the real page handlers. */
function nodes(node, type) {
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child, type));
  if (!node || typeof node !== 'object') return [];
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}
function render() {
  h.cursor = 0;
  return ApplicationsPage();
}
async function mount(draw = render, load = h.load) {
  draw();
  h.effects.splice(0).forEach((effect) => effect());
  await load.mock.results[0].value;
  await Promise.resolve();
  await Promise.resolve();
  return draw();
}
function renderTracker() {
  h.cursor = 0;
  return ApplicationTracker({ listingId: 'flat' });
}
const application = {
  id: 'app',
  listingId: 'flat',
  title: 'A flat',
  status: 'draft',
  followUpAt: '2026-10-01T12:00:00Z',
};

beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
  h.load.mockReset().mockResolvedValue({ applications: [application] });
  h.save.mockReset().mockResolvedValue({ application: { ...application, status: 'submitted' } });
  h.loadOne.mockReset().mockResolvedValue({ application: null, events: [] });
  h.addEvent.mockReset().mockResolvedValue({
    application,
    events: [{ id: 'event', kind: 'reply', source: 'manual', text: 'A viewing is available.' }],
  });
  h.letter.mockReset().mockResolvedValue({ text: 'My application letter' });
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('Applications status management', () => {
  it('loads applications without mail setup and saves only the changed status', async () => {
    let tree = await mount();
    expect(h.load).toHaveBeenCalledTimes(1);
    const status = nodes(tree, 'select')[0];
    expect(status.props.value).toBe('draft');
    expect(nodes(tree, 'fieldset')).toHaveLength(0);
    expect(nodes(tree, 'input').map((node) => node.props.type)).toEqual(['checkbox']);
    await status.props.onChange({ target: { value: 'submitted' } });
    expect(h.save).toHaveBeenCalledWith('flat', { status: 'submitted' });
    tree = render();
    expect(nodes(tree, 'select')[0].props.value).toBe('submitted');
    expect(nodes(tree, 'p').some((node) => node.props.children === 'search.saved')).toBe(true);
  });
  it('retains the stored status and displays an error when saving fails', async () => {
    const tree = await mount();
    h.save.mockRejectedValue({ status: 500, json: { error: 'Unable to save status.' } });
    await nodes(tree, 'select')[0].props.onChange({ target: { value: 'rejected' } });
    const after = render();
    expect(nodes(after, 'select')[0].props.value).toBe('draft');
    expect(
      nodes(after, 'p').some((node) => node.props.role === 'alert' && node.props.children === 'Unable to save status.'),
    ).toBe(true);
    expect(nodes(after, 'select')[0].props.disabled).toBe(false);
  });
  it('removes a completed application from due follow-ups after its status is saved', async () => {
    let tree = await mount();
    nodes(tree, 'input')[0].props.onChange({ target: { checked: true } });
    tree = render();
    expect(nodes(tree, 'select')).toHaveLength(1);
    h.save.mockResolvedValue({ application: { ...application, status: 'accepted' } });
    await nodes(tree, 'select')[0].props.onChange({ target: { value: 'accepted' } });
    expect(nodes(render(), 'select')).toHaveLength(0);
  });
});

describe('Listing application tracker without email integration', () => {
  it('saves a status with empty contact and letter fields, with no send or setup controls', async () => {
    let tree = await mount(renderTracker, h.loadOne);
    const status = nodes(tree, 'select')[0];
    status.props.onChange({ target: { value: 'submitted' } });
    tree = renderTracker();
    expect(nodes(tree, 'input').filter((node) => node.props.type === 'datetime-local')).toHaveLength(2);
    expect(nodes(tree, 'button').map((node) => node.props.children)).toEqual([
      'search.draftLetter',
      'search.saveApplication',
      'search.addEvent',
    ]);
    const save = nodes(tree, 'button').find((node) => node.props.children === 'search.saveApplication');
    expect(save.props.disabled).toBe(false);
    await save.props.onClick();
    expect(h.save).toHaveBeenCalledWith('flat', {
      status: 'submitted',
      recipient: '',
      subject: '',
      body: '',
      visitAt: null,
      followUpAt: null,
    });
  });
  it('generates a letter draft without marking the application submitted', async () => {
    const tree = await mount(renderTracker, h.loadOne);
    await nodes(tree, 'button')
      .find((node) => node.props.children === 'search.draftLetter')
      .props.onClick();
    expect(h.letter).toHaveBeenCalledWith('flat');
    expect(h.save).not.toHaveBeenCalled();
    const after = renderTracker();
    expect(nodes(after, 'textarea')[0].props.value).toBe('My application letter');
    expect(nodes(after, 'select')[0].props.value).toBe('draft');
  });
  it('records a manual reply and displays it in the timeline', async () => {
    let tree = await mount(renderTracker, h.loadOne);
    nodes(tree, 'select')[1].props.onChange({ target: { value: 'reply' } });
    nodes(tree, 'textarea')[1].props.onChange({ target: { value: 'A viewing is available.' } });
    tree = renderTracker();
    await nodes(tree, 'button')
      .find((node) => node.props.children === 'search.addEvent')
      .props.onClick();
    expect(h.addEvent).toHaveBeenCalledWith('flat', { kind: 'reply', text: 'A viewing is available.' });
    expect(nodes(renderTracker(), 'li')).toHaveLength(1);
  });
});

describe('automatic application live status', () => {
  it('refreshes saved lifecycle statuses after an auto-apply event', async () => {
    await mount();
    h.load.mockResolvedValue({ applications: [{ ...application, status: 'submitted' }] });
    await h.listener();
    expect(nodes(render(), 'select')[0].props.value).toBe('submitted');
  });
  it('preserves a typed letter while refreshing the listing timeline', async () => {
    let tree = await mount(renderTracker, h.loadOne);
    nodes(tree, 'textarea')[0].props.onChange({ target: { value: 'My unsaved letter' } });
    h.loadOne.mockResolvedValue({
      application: { ...application, body: 'Automatic letter' },
      events: [{ id: 'sent', kind: 'updated', text: 'Application submitted.' }],
    });
    await h.listener();
    tree = renderTracker();
    expect(nodes(tree, 'textarea')[0].props.value).toBe('My unsaved letter');
    expect(nodes(tree, 'li')).toHaveLength(1);
  });
});
