/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { criterionPresentation, CRITERION_ICONS } from '../../ui/src/services/listings/criterionPresentation.js';
import FitCriterionIcon from '../../ui/src/components/searchWorkspace/FitCriterionIcon.jsx';

const labels = {
  rooms: '{{value}}+ rooms',
  size: '{{value}}+ m²',
  budget: '≤ {{value}}',
  transit: '{{line}} · {{minutes}} min',
  anyTransit: 'Metro · {{minutes}} min',
  bedrooms: 'Bedrooms',
  kitchen: 'Kitchen',
  pets: 'Pets',
  outdoor: 'Outdoor space',
  lift: 'Lift',
  lease: 'Lease',
  furniture: 'Furnishing',
  budgetTopic: 'Budget',
  roomsTopic: 'Rooms',
  sizeTopic: 'Living space',
  transitTopic: 'Transit',
  requirement: 'Requirement {{number}}',
};
const t = (key, values = {}) =>
  Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
    labels[key.replace('search.chip.', '')] ?? key,
  );
const present = (criterion, options = {}) => criterionPresentation(criterion, { t, locale: 'en-GB', ...options });

describe('requirement keyword presentation', () => {
  it.each([
    [{ kind: 'min_rooms', value: 3.5 }, 'rooms', '3.5+ rooms'],
    [{ kind: 'min_size', value: 80 }, 'size', '80+ m²'],
    [{ kind: 'max_price', value: 2000 }, 'budget', '≤ €2,000'],
    [{ kind: 'station_line', line: 'U2', maxWalkMinutes: 10 }, 'transit', 'U2 · 10 min'],
    [{ kind: 'station_line', line: '*', maxWalkMinutes: 5 }, 'transit', 'Metro · 5 min'],
  ])('preserves structured threshold %j as a concise label and meaningful icon', (criterion, icon, label) => {
    expect(present({ ...criterion, text: 'A lengthy source requirement that must not be the chip label' })).toEqual({
      icon,
      label,
    });
  });
  it.each([
    ['At least two separate bedrooms, not total rooms', 'Bedrooms', 'rooms'],
    ['Einbauküche mit einem großen Kühlschrank', 'Kitchen', 'kitchen'],
    ['Our dog must be allowed', 'Pets', 'pets'],
    ['Haustiere müssen erlaubt sein', 'Pets', 'pets'],
    ['No furnished short-term apartment', 'Lease', 'lease'],
    ['Die Wohnung sollte unmöbliert sein', 'Furnishing', 'furniture'],
    ['Balkon oder Terrasse für Pflanzen', 'Outdoor space', 'outdoor'],
    ['Fahrstuhl erforderlich', 'Lift', 'lift'],
    ['Unbefristeter Mietvertrag', 'Lease', 'lease'],
    ['The subway station should be nearby', 'Transit', 'transit'],
  ])('uses a topic keyword for %s without claiming it summarizes the full requirement', (text, label, icon) => {
    expect(present({ text, kind: 'semantic' })).toEqual({ label, icon });
  });
  it('supports user-selected short labels and icons, and ignores unsupported or excessive values', () => {
    expect(present({ text: 'Private preferences', label: '  Quiet street  ', icon: 'outdoor' })).toEqual({
      label: 'Quiet street',
      icon: 'outdoor',
    });
    expect(present({ text: 'Private preferences', label: 'x'.repeat(33), icon: '<script>' }, { index: 4 })).toEqual({
      label: 'Requirement 5',
      icon: 'requirement',
    });
    expect(present({ text: 'Private preferences', label: '   ', icon: null })).toEqual({
      label: 'Requirement 1',
      icon: 'requirement',
    });
  });
  it('does not guess a summary for unsupported text or mutate stored preferences', () => {
    const criterion = { text: '<script>Preference with unusual wording</script>', kind: 'semantic' };
    const snapshot = { ...criterion };
    expect(present(criterion, { index: 2 })).toEqual({ label: 'Requirement 3', icon: 'requirement' });
    expect(criterion).toEqual(snapshot);
  });
  it('formats structured numbers for the selected locale', () => {
    expect(present({ kind: 'min_rooms', value: 3.5 }, { locale: 'de-DE' }).label).toBe('3,5+ rooms');
    expect(present({ kind: 'max_price', value: 2000 }, { locale: 'de-DE' }).label).toBe('≤ 2.000 €');
  });
  it('renders a distinct decorative drawing for every supported topic and a safe fallback', () => {
    const drawings = CRITERION_ICONS.map((topic) => renderToStaticMarkup(createElement(FitCriterionIcon, { topic })));
    expect(new Set(drawings.map((markup) => markup.replace(/ data-topic="[^"]*"/, ''))).size).toBe(
      CRITERION_ICONS.length,
    );
    for (const markup of drawings) {
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('focusable="false"');
      expect(markup).toContain('currentColor');
    }
    const fallback = renderToStaticMarkup(createElement(FitCriterionIcon, { topic: 'unsupported' }));
    expect(fallback).toContain('<path');
  });
});
