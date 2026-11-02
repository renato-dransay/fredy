/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [],
  save: vi.fn(),
  reload: vi.fn(),
  input: vi.fn(),
  browserControl: vi.fn(),
}));
vi.mock('react', () => ({
  useState: (initial) => {
    const slot = h.cursor++;
    h.slots[slot] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [
      h.slots[slot].value,
      (update) => {
        h.slots[slot].value = typeof update === 'function' ? update(h.slots[slot].value) : update;
      },
    ];
  },
  useEffect: () => {},
}));
vi.mock('@douyinfe/semi-ui-19', () => ({ Button: 'button', InputNumber: 'number' }));
vi.mock('react-router', () => ({ Link: 'a' }));
vi.mock('../../ui/src/services/autoApplyClient.js', () => ({
  saveAutoApplyRule: h.save,
  autoApplyBrowserInput: h.input,
  controlAutoApplyBrowser: h.browserControl,
}));

import { AutoApplyRuleForm, editableRule } from '../../ui/src/components/autoApply/AutoApplyRuleEditor.jsx';
import AutoApplyBrowser, { browserPoint } from '../../ui/src/components/autoApply/AutoApplyBrowser.jsx';

function nodes(node, type) {
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child, type));
  if (!node || typeof node !== 'object') return [];
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}
const job = { id: 'job', name: 'My search' };
const data = () => ({
  rules: [
    {
      jobId: 'job',
      enabled: false,
      minimumScore: 8,
      portals: ['immoscout'],
      connectionIds: { immoscout: 'browser' },
      documentIds: [],
    },
  ],
  model: { model: 'provider/model', checked: true },
  portals: [{ id: 'immoscout', name: 'ImmoScout24' }],
  connections: [{ id: 'browser', portal: 'immoscout', name: 'My account', qualified: true }],
  documents: [{ id: 'private-file', filename: 'Applicant.pdf' }],
});
function render(snapshot) {
  h.cursor = 0;
  return AutoApplyRuleForm({ job, data: snapshot, reload: h.reload });
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.save.mockReset().mockResolvedValue({});
  h.reload.mockReset();
  h.input.mockReset().mockResolvedValue({});
  h.browserControl.mockReset().mockResolvedValue({});
});

describe('automatic application rule controls', () => {
  it('starts disabled and sends only the explicit portal, document, score and authorization choices', async () => {
    const snapshot = data();
    let tree = render(snapshot);
    const checks = nodes(tree, 'input');
    expect(checks.at(-1).props.checked).toBe(false);
    expect(checks.at(-1).props.disabled).toBe(false);
    checks[1].props.onChange({ target: { checked: true } });
    tree = render(snapshot);
    nodes(tree, 'number')[0].props.onChange(8.3);
    tree = render(snapshot);
    nodes(tree, 'input')
      .at(-1)
      .props.onChange({ target: { checked: true } });
    tree = render(snapshot);
    await nodes(tree, 'button')[0].props.onClick();
    expect(h.save).toHaveBeenCalledWith('job', {
      enabled: true,
      minimumScore: 8.3,
      portals: ['immoscout'],
      documentIds: ['private-file'],
      connectionIds: { immoscout: 'browser' },
    });
    expect(h.reload).toHaveBeenCalledOnce();
  });
  it('cannot enable a rule with an unqualified connection or unchecked model', () => {
    const snapshot = data();
    snapshot.connections[0].qualified = false;
    expect(nodes(render(snapshot), 'input').at(-1).props.disabled).toBe(true);
    snapshot.connections[0].qualified = true;
    snapshot.model.checked = false;
    expect(nodes(render(snapshot), 'input').at(-1).props.disabled).toBe(true);
  });
  it('allows disabling an enabled rule after a browser loses qualification', async () => {
    const snapshot = data();
    snapshot.rules[0].enabled = true;
    snapshot.connections[0].qualified = false;
    const tree = render(snapshot);
    const authorize = nodes(tree, 'input').at(-1);
    expect(authorize.props.disabled).toBe(false);
    authorize.props.onChange({ target: { checked: false } });
    const after = render(snapshot);
    expect(nodes(after, 'button')[0].props.disabled).toBe(false);
    await nodes(after, 'button')[0].props.onClick();
    expect(h.save.mock.calls[0][1].enabled).toBe(false);
  });
  it('keeps the unsaved rule and displays the backend failure when a save is rejected', async () => {
    h.save.mockRejectedValue({ json: { error: 'Portal qualification expired.' } });
    const snapshot = data();
    await nodes(render(snapshot), 'button')[0].props.onClick();
    expect(
      nodes(render(snapshot), 'p').some(
        (item) => item.props.role === 'alert' && item.props.children === 'Portal qualification expired.',
      ),
    ).toBe(true);
    expect(h.reload).not.toHaveBeenCalled();
  });
  it('never serializes worker tokens and starts new rules with no document sharing', () => {
    expect(editableRule({ token: 'private', receipt: {}, minimumScore: 0 })).toEqual({
      enabled: false,
      minimumScore: 0,
      portals: [],
      documentIds: [],
      connectionIds: {},
    });
  });
});

describe('human browser screenshot coordinates', () => {
  const target = {
    naturalWidth: 1600,
    naturalHeight: 900,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 450 }),
  };
  it('maps a resized screenshot to browser pixels', () => {
    expect(browserPoint({ currentTarget: target, clientX: 410, clientY: 245 })).toEqual({ x: 800, y: 450 });
  });
  it('ignores clicks in the letterbox or outside the screenshot', () => {
    const letterboxed = { ...target, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 450 }) };
    expect(browserPoint({ currentTarget: letterboxed, clientX: 900, clientY: 100 })).toBeNull();
    expect(browserPoint({ currentTarget: target, clientX: 2, clientY: 25 })).toBeNull();
  });
});

describe('explicit portal login qualification', () => {
  it('asks the worker to verify the exact portal identity without authorizing a submission', async () => {
    const draw = () => {
      h.cursor = 0;
      return AutoApplyBrowser({
        connection: { id: 'browser', name: 'Portal', qualified: false },
        reload: h.reload,
        onClose: vi.fn(),
      });
    };
    let tree = draw();
    expect(nodes(tree, 'button').find((button) => button.props.children === 'Verify login').props.disabled).toBe(true);
    nodes(tree, 'input')
      .find((input) => input.props.type === 'text')
      .props.onChange({ target: { value: '  Applicant Name  ' } });
    tree = draw();
    await nodes(tree, 'button')
      .find((button) => button.props.children === 'Verify login')
      .props.onClick();
    expect(h.input).toHaveBeenCalledWith('browser', { type: 'verify_login', accountIdentity: 'Applicant Name' });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.browserControl).not.toHaveBeenCalled();
  });
});
