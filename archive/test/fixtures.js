// Generates sample files of many formats for the tests (so no big binaries live in git).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CFB from 'cfb';
import { writePsdBuffer } from 'ag-psd';
import { strToU8, zipSync } from 'fflate';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function poster(width = 600, height = 800) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#e8402a"/>
    <circle cx="${width / 2}" cy="${height / 2.6}" r="${width / 3.2}" fill="#f5d020"/>
    <rect x="40" y="${height - 180}" width="${width - 80}" height="120" fill="#111"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

export async function makeFixtures(dir) {
  await fs.mkdir(dir, { recursive: true });
  const w = (name, data) => fs.writeFile(path.join(dir, name), data);
  const jpg = await poster();

  await w('poster.jpg', jpg);
  await w('poster.png', await sharp(jpg).png().toBuffer());
  await w('poster.webp', await sharp(jpg).webp().toBuffer());
  await w('poster.avif', await sharp(jpg).avif().toBuffer());
  await w('poster.tiff', await sharp(jpg).tiff().toBuffer());
  await w('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#0a7"/></svg>');
  await w('sample.heic', await fs.readFile(path.join(here, 'fixtures', 'sample.heic')));

  // Photoshop file with a composite image
  const { data, info } = await sharp(jpg).resize(300, 400).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const psd = writePsdBuffer({
    width: info.width,
    height: info.height,
    imageData: { width: info.width, height: info.height, data: new Uint8ClampedArray(data) },
    children: [],
  });
  await w('layout.psd', psd);

  // Writings
  await w('memo.md', '# Poster ideas\n\n- Swiss grid, red + yellow\n- Big circle\n\nMore notes about typography and film.');
  await w('korean.txt', '영화감독 아핏차퐁 위라세타쿤\n기억과 꿈의 경계에 대한 메모');
  await w(
    'letter.rtf',
    '{\\rtf1\\ansi\\ansicpg949\\uc1{\\fonttbl{\\f0 Helvetica;}}\\f0 Hello \\u54620?\\u44544? world\\par ' +
      "\\'c7\\'d1\\'b1\\'db second line}",
  );
  await w('page.html', '<html><head><title>Saved page</title><style>p{}</style></head><body><h1>Brutalism</h1><p>Concrete &amp; light.</p></body></html>');
  await w(
    'essay.docx',
    zipSync({
      'word/document.xml': strToU8(
        '<w:document><w:body><w:p><w:r><w:t>Essay on</w:t></w:r><w:r><w:t xml:space="preserve"> Tarkovsky</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Water, mirrors &amp; time.</w:t></w:r></w:p></w:body></w:document>',
      ),
    }),
  );
  await w(
    'report.hwpx',
    zipSync({
      'Contents/section0.xml': strToU8('<hs:sec><hp:p><hp:run><hp:t>한글 문서 첫 줄</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>둘째 줄</hp:t></hp:run></hp:p></hs:sec>'),
    }),
  );
  const hwp = CFB.utils.cfb_new();
  CFB.utils.cfb_add(hwp, 'PrvText', Buffer.from('<한글 미리보기 텍스트><두 번째 문단>', 'utf16le'));
  await w('old.hwp', CFB.write(hwp, { type: 'buffer' }));
  await w('subs.srt', '1\n00:00:01,000 --> 00:00:02,000\nWhere are we going?\n\n2\n00:00:03,000 --> 00:00:04,000\nHome.\n');

  // PDF with text and an image
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Manifesto for slow cinema', { x: 50, y: 780, size: 24, font, color: rgb(0, 0, 0) });
  page.drawText('Long takes, landscapes, patience.', { x: 50, y: 740, size: 14, font });
  page.drawImage(await pdf.embedJpg(jpg), { x: 50, y: 200, width: 300, height: 400 });
  await w('manifesto.pdf', await pdf.save());

  // Design file with an embedded preview (Pages/Keynote/Sketch are zips like this)
  await w('deck.key', zipSync({ 'Index/Document.iwa': new Uint8Array(10), 'preview.jpg': new Uint8Array(await sharp(jpg).resize(200).jpeg().toBuffer()) }));

  // Links
  await w('YouTube clip.url', '[InternetShortcut]\r\nURL=https://www.youtube.com/watch?v=dQw4w9WgXcQ\r\n');
  await w(
    'Mac link.webloc',
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>URL</key><string>https://example.com/?a=1&amp;b=2</string></dict></plist>',
  );

  // Unknown extension that is really text
  await w('notes.unknownext', 'just some plain text\nsecond line');
  // A real binary blob
  await w('blob.bin', Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
}
