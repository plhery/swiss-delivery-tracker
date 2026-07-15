export interface TouchPoint {
  x: number;
  y: number;
}

export function isLeftSwipe(
  start: TouchPoint,
  end: TouchPoint,
  minimumDistance = 72,
): boolean {
  const horizontal = end.x - start.x;
  const vertical = end.y - start.y;
  return (
    horizontal <= -minimumDistance &&
    Math.abs(horizontal) > Math.abs(vertical) * 1.25
  );
}
