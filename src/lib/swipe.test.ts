import { describe, expect, it } from 'vitest';
import { isBackSwipe } from './swipe';

describe('isBackSwipe', () => {
  it('accepts an iOS-style swipe right from the left edge', () => {
    expect(isBackSwipe({ x: 12, y: 160 }, { x: 142, y: 172 })).toBe(true);
  });

  it('ignores short, off-edge, leftward, and mostly vertical gestures', () => {
    expect(isBackSwipe({ x: 12, y: 100 }, { x: 62, y: 100 })).toBe(false);
    expect(isBackSwipe({ x: 80, y: 100 }, { x: 200, y: 100 })).toBe(false);
    expect(isBackSwipe({ x: 20, y: 100 }, { x: -80, y: 100 })).toBe(false);
    expect(isBackSwipe({ x: 12, y: 100 }, { x: 102, y: 240 })).toBe(false);
  });
});
