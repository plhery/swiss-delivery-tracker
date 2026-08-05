export interface TouchPoint {
  x: number;
  y: number;
}

export function isBackSwipe(
  start: TouchPoint,
  end: TouchPoint,
  minimumDistance = 72,
  edgeWidth = 36,
): boolean {
  const horizontal = end.x - start.x;
  const vertical = end.y - start.y;
  return (
    start.x <= edgeWidth &&
    horizontal >= minimumDistance &&
    Math.abs(horizontal) > Math.abs(vertical) * 1.25
  );
}
