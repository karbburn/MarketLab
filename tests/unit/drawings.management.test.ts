import { describe, expect, it } from 'vitest';
import type { Drawing } from '../../src/domain/types';
import {
  drawingLabel,
  drawingTypeLabel,
  hexColorForInput,
  removeDrawing,
  sameStyle,
  setDrawingLocked,
  setDrawingStyle,
  setDrawingText,
  setDrawingVisibility,
  toggleDrawingLocked,
  toggleDrawingVisibility,
} from '../../src/lib/drawings/management';

function drawing(overrides: Partial<Drawing> = {}): Drawing {
  return {
    id: 'drw-1',
    type: 'trendline',
    anchors: [{ date: '2026-01-02', price: 100 }],
    visible: true,
    locked: false,
    style: { color: '#3fb8a3', lineWidth: 1.5 },
    ...overrides,
  };
}

describe('drawing labels', () => {
  it('uses the tool vocabulary for shape labels', () => {
    expect(drawingTypeLabel('horizontal-line')).toBe('Horizontal level');
    expect(drawingTypeLabel('price-range')).toBe('Measure move');
    expect(drawingLabel(drawing({ type: 'rectangle' }))).toBe('Zone rectangle');
  });

  it('uses a text drawing label, falling back when it is blank', () => {
    expect(drawingLabel(drawing({ type: 'text', text: 'Breakout' }))).toBe('Breakout');
    expect(drawingLabel(drawing({ type: 'text', text: '   ' }))).toBe('Text label');
  });
});

describe('drawing visibility and locking', () => {
  it('toggles only the addressed drawing', () => {
    const first = drawing();
    const second = drawing({ id: 'drw-2', type: 'rectangle' });
    const toggled = toggleDrawingVisibility([first, second], first.id);
    expect(toggled[0]?.visible).toBe(false);
    expect(toggled[1]).toBe(second);
    expect(toggleDrawingVisibility(toggled, first.id)[0]?.visible).toBe(true);
  });

  it('returns the same array for an unknown id or an unchanged value', () => {
    const drawings = [drawing()];
    expect(toggleDrawingVisibility(drawings, 'missing')).toBe(drawings);
    expect(setDrawingVisibility(drawings, drawings[0]?.id ?? '', true)).toBe(drawings);
  });

  it('locks and unlocks a drawing', () => {
    const drawings = [drawing()];
    const locked = toggleDrawingLocked(drawings, drawings[0]?.id ?? '');
    expect(locked[0]?.locked).toBe(true);
    expect(setDrawingLocked(locked, locked[0]?.id ?? '', false)[0]?.locked).toBe(false);
  });
});

describe('drawing style edits', () => {
  it('merges and normalizes the style patch', () => {
    const drawings = [drawing({ type: 'rectangle' })];
    const next = setDrawingStyle(drawings, drawings[0]?.id ?? '', {
      color: '#ef6f6c',
      lineWidth: 20,
      lineStyle: 'dashed',
      fillOpacity: 2,
    });
    expect(next[0]?.style).toEqual({
      color: '#ef6f6c',
      lineWidth: 8,
      lineStyle: 'dashed',
      fillOpacity: 1,
    });
  });

  it('keeps the array when the patch changes nothing', () => {
    const drawings = [drawing({ style: { color: '#3fb8a3', lineWidth: 1.5, lineStyle: 'solid' } })];
    expect(setDrawingStyle(drawings, drawings[0]?.id ?? '', { color: '#3fb8a3' })).toBe(drawings);
  });

  it('refuses style edits on a locked drawing', () => {
    const drawings = [drawing({ locked: true })];
    expect(setDrawingStyle(drawings, drawings[0]?.id ?? '', { color: '#ef6f6c' })).toBe(drawings);
  });
});

describe('drawing text and deletion', () => {
  it('trims and stores text, but ignores empty text', () => {
    const drawings = [drawing({ type: 'text', text: 'Old' })];
    const next = setDrawingText(drawings, drawings[0]?.id ?? '', '  Breakout  ');
    expect(next[0]?.text).toBe('Breakout');
    expect(setDrawingText(drawings, drawings[0]?.id ?? '', '   ')).toBe(drawings);
  });

  it('refuses text edits on a locked drawing', () => {
    const drawings = [drawing({ type: 'text', text: 'Old', locked: true })];
    expect(setDrawingText(drawings, drawings[0]?.id ?? '', 'New')).toBe(drawings);
  });

  it('deletes an unlocked drawing and preserves a locked one', () => {
    const drawings = [drawing(), drawing({ id: 'drw-2', locked: true })];
    const removed = removeDrawing(drawings, drawings[0]?.id ?? '');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.id).toBe('drw-2');
    expect(removeDrawing(drawings, 'drw-2')).toBe(drawings);
    expect(removeDrawing(drawings, 'missing')).toBe(drawings);
  });
});

describe('drawing color helpers', () => {
  it('normalizes a color for the native color input', () => {
    expect(hexColorForInput('#ABC')).toBe('#aabbcc');
    expect(hexColorForInput('#EF6F6C')).toBe('#ef6f6c');
    expect(hexColorForInput('red')).toBe('#3fb8a3');
    expect(hexColorForInput('red', '#ffffff')).toBe('#ffffff');
  });

  it('treats undefined optional values as their render defaults', () => {
    expect(sameStyle({ color: '#fff', lineWidth: 1 }, { color: '#fff', lineWidth: 1 })).toBe(true);
    expect(sameStyle({ color: '#fff', lineWidth: 1 }, { color: '#000', lineWidth: 1 })).toBe(false);
  });
});
