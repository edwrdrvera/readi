import { coverUrl } from "./api";

export interface SpineColors {
  bg: string;
  ink: string;
}

/** Spine colors from RGBA pixels: the average opaque color, with whichever ink contrasts more. */
export function spineColors(rgba: ArrayLike<number>): SpineColors | null {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
    n++;
  }
  if (n === 0) return null;
  [r, g, b] = [r / n, g / n, b / n].map(Math.round);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Equal-contrast point between black and white text.
  const ink = luminance > 0.179 ? "#1d1d1f" : "#f5f5f7";
  return { bg: `rgb(${r} ${g} ${b})`, ink };
}

const cache = new Map<number, Promise<SpineColors | null>>();

/** Samples the cover's left edge, where a real book's cover wraps round the spine. */
export function coverSpineColors(bookId: number): Promise<SpineColors | null> {
  let hit = cache.get(bookId);
  if (!hit) {
    hit = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onerror = () => resolve(null);
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 4;
        canvas.height = 32;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        const strip = Math.max(1, Math.round(img.naturalWidth * 0.08));
        ctx.drawImage(img, 0, 0, strip, img.naturalHeight, 0, 0, canvas.width, canvas.height);
        try {
          resolve(spineColors(ctx.getImageData(0, 0, canvas.width, canvas.height).data));
        } catch {
          resolve(null);
        }
      };
      img.src = coverUrl(bookId);
    });
    cache.set(bookId, hit);
  }
  return hit;
}
