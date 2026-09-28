import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

sharp.cache(false);

const THUMB = 640; // grid thumbnails (WebP)
const PREVIEW = 1600; // large JPEG previews for formats browsers can't show (HEIC, TIFF, PSD, RAW, video…)
const TAGGING = 1024; // what the tagger sends to the model

/**
 * Thumbnail/preview cache in DATA_DIR, keyed by content hash:
 *   thumbs/<hash>.webp    every visual block
 *   previews/<hash>.jpg   only for sources the browser can't display natively
 */
export class Thumbs {
  constructor(dataDir) {
    this.thumbDir = path.join(dataDir, 'thumbs');
    this.previewDir = path.join(dataDir, 'previews');
  }

  async init() {
    await fsp.mkdir(this.thumbDir, { recursive: true });
    await fsp.mkdir(this.previewDir, { recursive: true });
  }

  thumbPath(hash) {
    return path.join(this.thumbDir, `${hash}.webp`);
  }

  previewPath(hash) {
    return path.join(this.previewDir, `${hash}.jpg`);
  }

  /**
   * Build the thumbnail (and optionally a preview) from any sharp-readable input (path or Buffer).
   * Returns { width, height, color } of the source image. Throws if sharp can't decode it.
   */
  async fromImage(input, hash, { preview = false, animated = false, density } = {}) {
    const opts = { failOn: 'none', limitInputPixels: 1e9, ...(density ? { density } : {}) };
    const meta = await sharp(input, opts).metadata();
    const pages = meta.pages || 1;
    const anim = animated && pages > 1 && pages <= 200;

    const thumb = await sharp(input, { ...opts, animated: anim })
      .rotate()
      .resize(THUMB, THUMB, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();
    await fsp.writeFile(this.thumbPath(hash), thumb);

    if (preview) {
      const big = await sharp(input, opts)
        .rotate()
        .resize(PREVIEW, PREVIEW, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 84, mozjpeg: true })
        .toBuffer();
      await fsp.writeFile(this.previewPath(hash), big);
    }

    const { dominant } = await sharp(thumb).stats();
    const color = '#' + [dominant.r, dominant.g, dominant.b].map((v) => v.toString(16).padStart(2, '0')).join('');
    // EXIF orientations 5–8 swap width and height.
    const swap = (meta.orientation || 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : (meta.pageHeight || meta.height);
    return { width, height, color };
  }

  /** A 2×2 contact sheet of video frames, stored as the preview so Claude sees the whole clip. */
  async contactSheet(frames, hash) {
    const tile = 512;
    const tiles = await Promise.all(
      frames.slice(0, 4).map((f) => sharp(f).resize(tile, tile, { fit: 'contain', background: '#000' }).toBuffer()),
    );
    const cols = tiles.length > 1 ? 2 : 1;
    const rows = Math.ceil(tiles.length / cols);
    const sheet = await sharp({ create: { width: cols * tile, height: rows * tile, channels: 3, background: '#000' } })
      .composite(tiles.map((input, i) => ({ input, left: (i % cols) * tile, top: Math.floor(i / cols) * tile })))
      .jpeg({ quality: 82 })
      .toBuffer();
    await fsp.writeFile(this.previewPath(hash), sheet);
  }

  async remove(hash) {
    await fsp.rm(this.thumbPath(hash), { force: true });
    await fsp.rm(this.previewPath(hash), { force: true });
  }
}

/** Downscale any image input to the JPEG sent for tagging (≤1024 px). */
export async function imageForTagging(input) {
  const data = await sharp(input, { failOn: 'none', limitInputPixels: 1e9 })
    .rotate()
    .resize(TAGGING, TAGGING, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') };
}
