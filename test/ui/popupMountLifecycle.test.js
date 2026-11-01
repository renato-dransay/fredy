/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

const context = vi.hoisted(() => ({ roots: [] }));
vi.mock('react-dom/client', () => ({
  createRoot: (container) => {
    const node = { parentNode: null };
    const root = {
      render: () => container.replaceChildren(node),
      unmount: vi.fn(() => container.removeChild(node)),
    };
    context.roots.push(root);
    return root;
  },
}));
vi.mock('../../ui/src/services/i18n/i18n.jsx', () => ({ I18nProvider: function I18nProvider() {} }));
import { mountPopupNode } from '../../ui/src/components/map/popupContent.jsx';

/** Minimal DOM ownership semantics: removing another root's node must fail like the browser. */
class Container {
  childNodes = [];
  parentNode = null;
  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
  }
  removeChild(node) {
    if (node.parentNode !== this) throw new Error('NotFoundError');
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
  }
  replaceChildren(node) {
    this.childNodes.forEach((child) => {
      child.parentNode = null;
    });
    this.childNodes = [];
    this.appendChild(node);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  context.roots = [];
});

describe('popup root ownership during rapid close and reopen', () => {
  it('keeps the reopened content intact when the previous deferred unmount runs', () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { createElement: () => new Container() });
    const container = new Container();
    const close = mountPopupNode(container, createElement('span', null, 'first'), 'en');
    close();
    const closeAgain = mountPopupNode(container, createElement('span', null, 'reopened'), 'en');
    const reopened = container.childNodes[0];
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    expect(container.childNodes).toEqual([reopened]);
    expect(context.roots[0].unmount).toHaveBeenCalledTimes(1);
    expect(context.roots[1].unmount).not.toHaveBeenCalled();
    closeAgain();
    closeAgain();
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    expect(container.childNodes).toEqual([]);
    expect(context.roots[1].unmount).toHaveBeenCalledTimes(1);
  });
});
