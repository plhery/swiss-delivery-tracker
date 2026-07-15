import { describe, expect, it } from 'vitest';
import { isLeftSwipe } from './swipe';

describe('isLeftSwipe', () => {
  it('accepts a deliberate horizontal swipe to the left', () => {
    expect(isLeftSwipe({ x: 280, y: 160 }, { x: 150, y: 172 })).toBe(true);
  });

  it('ignores short, rightward, and mostly vertical gestures', () => {
    expect(isLeftSwipe({ x: 200, y: 100 }, { x: 150, y: 100 })).toBe(false);
    expect(isLeftSwipe({ x: 100, y: 100 }, { x: 220, y: 100 })).toBe(false);
    expect(isLeftSwipe({ x: 250, y: 100 }, { x: 160, y: 240 })).toBe(false);
  });
});
