/**
 * Pure swipe decision helpers for activity cards.
 * Left swipe archives the card. Right swipe performs the card's suggested
 * action, and that swipe is the owner's approval.
 */

export type SwipeDecision = 'archive' | 'accept' | 'none';

export const DEFAULT_SWIPE_THRESHOLD = 80;
export const MAX_DRAG_PX = 160;

export function decideSwipe({
  dx,
  threshold = DEFAULT_SWIPE_THRESHOLD,
}: {
  dx: number;
  threshold?: number;
}): SwipeDecision {
  if (dx <= -threshold) return 'archive';
  if (dx >= threshold) return 'accept';
  return 'none';
}

export function clampDrag(dx: number, max: number = MAX_DRAG_PX): number {
  if (dx > max) return max;
  if (dx < -max) return -max;
  return dx;
}
