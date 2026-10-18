// How the 3D avatar is framed: a half-length shot. Pure, tested.

/**
 * The bust's vertical span for a model `height` m tall: from a little above
 * the hips (the waist) to just above the top of the hair. Without a usable
 * hips bone, the upper 42% of the model.
 */
export function bustSpan(height: number, hipsY: number | null): { bottom: number; top: number } {
  const top = height + 0.03;
  const bottom = hipsY !== null && hipsY > height * 0.3 && hipsY < height * 0.75 ? hipsY + 0.06 : height * 0.58;
  return { bottom, top };
}
