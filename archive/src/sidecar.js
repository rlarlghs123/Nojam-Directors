import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './util.js';

/**
 * Tags are also saved next to your files, in <library>/.archive/meta/<content-hash>.json.
 * The files sync with iCloud / Google Drive like everything else, so a fresh install
 * (or a second computer) gets all tags back without paying for Claude again.
 * Keyed by content hash, so renaming or moving a file keeps its tags.
 */
export class Sidecars {
  constructor(libraryDir) {
    this.dir = path.join(libraryDir, '.archive', 'meta');
  }

  file(hash) {
    return path.join(this.dir, `${hash}.json`);
  }

  read(hash) {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(hash), 'utf8'));
      return data && data.v === 1 ? data : null;
    } catch {
      return null;
    }
  }

  async write(hash, data) {
    await fsp.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.file(hash), JSON.stringify({ v: 1, ...data }, null, 1));
  }
}
