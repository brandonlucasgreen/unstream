// Getting an image ready for the Promote asset library, in the browser: decoded, scaled down to
// 2,048px on its long side, and re-encoded as a JPEG (docs/specs/release-autopost-spec.md,
// "Uploads, kept small"). That keeps every upload far under a function's 6 MB body limit, turns
// the formats a browser can read (WebP, GIF, AVIF) into one Instagram and every network take, and
// drops whatever metadata the original carried, location included.

/** What the file picker offers. HEIC isn't here: only Safari can decode it. */
export const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp,image/gif,image/avif';

const MAX_EDGE = 2048;
const QUALITY = 0.88;

/** The file as base64 JPEG bytes, ready to send. Throws when the browser can't read it as an image. */
export async function prepareUpload(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('not an image');
  // `from-image` applies a photo's EXIF orientation, so a phone picture isn't stored sideways.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    // JPEG has no transparency: a transparent PNG gets a white background rather than black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob) throw new Error('could not encode');
    return toBase64(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // In chunks: String.fromCharCode with a whole photo's bytes overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
