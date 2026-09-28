import fsp from 'node:fs/promises';
import zlib from 'node:zlib';

// A tiny random-access ZIP reader. Many formats are ZIPs in disguise (docx, pptx, odt, hwpx, epub,
// Pages/Keynote/Numbers, Sketch, Figma, XD). We only need a few small entries from them, so we read
// the central directory and inflate just those entries instead of loading a 2 GB Keynote file.

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

export async function openZip(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        e = i;
        break;
      }
    }
    if (e < 0) throw new Error('not a zip file');
    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOffset = tail.readUInt32LE(e + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = e - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === EOCD64_LOCATOR) {
        const rec = await readAt(fh, Number(tail.readBigUInt64LE(loc + 8)), 56);
        if (rec.readUInt32LE(0) === EOCD64) {
          count = Number(rec.readBigUInt64LE(32));
          cdSize = Number(rec.readBigUInt64LE(40));
          cdOffset = Number(rec.readBigUInt64LE(48));
        }
      }
    }
    if (cdSize > 64 * 1024 * 1024) throw new Error('zip directory too large');
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = new Map();
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === CEN && entries.size < count) {
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      // ZIP64 sizes/offset live in extra field 0x0001, in this order, only when the 32-bit field is saturated.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) {
            usize = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (csize === 0xffffffff) {
            csize = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      if (!name.endsWith('/')) entries.set(name, { name, method, csize, usize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new Zip(file, entries);
  } finally {
    await fh.close();
  }
}

class Zip {
  constructor(file, entries) {
    this.file = file;
    this.entries = entries;
  }

  names() {
    return [...this.entries.keys()];
  }

  has(name) {
    return this.entries.has(name);
  }

  find(test) {
    return this.names().filter((n) => test(n, this.entries.get(n)));
  }

  async read(name, maxBytes = 64 * 1024 * 1024) {
    const e = this.entries.get(name);
    if (!e || e.usize > maxBytes) return null;
    const fh = await fsp.open(this.file, 'r');
    try {
      const head = await readAt(fh, e.offset, 30);
      if (head.readUInt32LE(0) !== LOC) return null;
      const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      const data = await readAt(fh, start, e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.usize, 1) + 1024 });
      return null;
    } finally {
      await fh.close();
    }
  }

  async text(name) {
    const buf = await this.read(name);
    return buf ? buf.toString('utf8') : null;
  }
}
