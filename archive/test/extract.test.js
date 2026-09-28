import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { decodeText, excerptOf, extractText, htmlToText, looksLikeText, rtfToText } from '../src/extract.js';
import { makeFixtures } from './fixtures.js';
import { tempDir } from './helpers.js';

describe('text extraction', () => {
  let dir;
  const read = async (name) => {
    const abs = path.join(dir, name);
    const { size } = await fs.stat(abs);
    return extractText(abs, name.split('.').pop(), size);
  };

  before(async () => {
    dir = await tempDir();
    await makeFixtures(dir);
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  test('markdown and plain text keep their lines', async () => {
    assert.match((await read('memo.md')).text, /^# Poster ideas\n\n- Swiss grid/);
    assert.equal((await read('korean.txt')).text.split('\n')[0], '영화감독 아핏차퐁 위라세타쿤');
  });

  test('Word, HWPX and HWP documents', async () => {
    assert.equal((await read('essay.docx')).text, 'Essay on Tarkovsky\nWater, mirrors & time.');
    assert.equal((await read('report.hwpx')).text, '한글 문서 첫 줄\n둘째 줄');
    assert.equal((await read('old.hwp')).text, '한글 미리보기 텍스트\n두 번째 문단');
  });

  test('RTF with unicode escapes and CP949 bytes', async () => {
    assert.equal((await read('letter.rtf')).text, 'Hello 한글 world\n한글 second line');
  });

  test('HTML gives text and title; subtitles drop timecodes', async () => {
    const html = await read('page.html');
    assert.equal(html.title, 'Saved page');
    assert.equal(html.text, 'Brutalism\nConcrete & light.');
    assert.equal((await read('subs.srt')).text, 'Where are we going?\n\nHome.');
  });

  test('PDF text and page count', async () => {
    const pdf = await read('manifesto.pdf');
    assert.equal(pdf.pages, 1);
    assert.match(pdf.text, /Manifesto for slow cinema/);
  });
});

describe('decoding helpers', () => {
  test('decodeText handles BOMs, UTF-8, CP949 and Windows-1252', () => {
    assert.equal(decodeText(Buffer.from('﻿hello', 'utf8')), 'hello');
    assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), 'hi');
    assert.equal(decodeText(Buffer.from('영화', 'utf8')), '영화');
    assert.equal(decodeText(Buffer.from([0xbf, 0xb5, 0xc8, 0xad])), '영화'); // CP949
    assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xe9, 0x74, 0xe9])), 'café été');
  });

  test('looksLikeText rejects binary', () => {
    assert.equal(looksLikeText(Buffer.from('plain text\n')), true);
    assert.equal(looksLikeText(Buffer.from([1, 0, 2, 3])), false);
  });

  test('rtfToText skips font tables and hidden destinations', () => {
    assert.equal(rtfToText('{\\rtf1{\\fonttbl{\\f0 Arial;}}{\\*\\generator Word;}Visible\\par text}'), 'Visible\ntext');
  });

  test('htmlToText drops scripts and styles', () => {
    assert.equal(htmlToText('<p>a<script>alert(1)</script></p><style>x{}</style><p>b &lt;3</p>'), 'a\nb <3');
  });

  test('excerptOf keeps the first lines', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const ex = excerptOf(text, { lines: 5 });
    assert.equal(ex, 'line 0\nline 1\nline 2\nline 3\nline 4');
    assert.ok(excerptOf('x'.repeat(5000)).length < 1000);
  });
});
