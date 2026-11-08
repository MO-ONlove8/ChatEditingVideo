export const VIDEO_FPS = 30;

/** A position in the normalized 30 fps video, never a floating-point second. */
export function formatTimecode(frame: number): string {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError('Invalid frame position');
  const frames = frame % VIDEO_FPS;
  const seconds = Math.floor(frame / VIDEO_FPS);
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60, frames];
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
  return parts.map((value) => String(value).padStart(2, '0')).join(':');
}
