'use strict';
/**
 * parse.js — resume file parsing: .pdf, .docx, .doc, .txt/.md → plain text.
 * Pure-JS adapters; no native deps.
 */
const { PDFParse } = require('pdf-parse');
const AdmZip = require('adm-zip');

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

function cleanText(t) {
  return String(t || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

async function parsePdf(buf) {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const out = await parser.getText();
    return { text: cleanText(out.text), warning: out.text.trim().length < 80 ? 'PDF extracted very little text — it may be a scanned image (OCR not supported yet).' : null };
  } finally { await parser.destroy().catch(() => {}); }
}

function parseDocx(buf) {
  const zip = new AdmZip(buf);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('not a valid .docx (word/document.xml missing)');
  const xml = entry.getData().toString('utf8');
  const text = xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return { text: cleanText(decodeEntities(text)), warning: null };
}

function parseDoc(buf) {
  // lazy-require: word-extractor is only needed for legacy .doc
  const WordExtractor = require('word-extractor');
  return new Promise((resolve, reject) => {
    try {
      const extractor = new WordExtractor();
      extractor.extract(buf).then((doc) => {
        resolve({ text: cleanText(doc.getBody()), warning: null });
      }).catch(reject);
    } catch (e) { reject(e); }
  });
}

/**
 * Parse a resume from raw bytes.
 * @returns {Promise<{text: string, warning: string|null}>}
 */
async function parseResume(filename, buffer) {
  const name = String(filename || '').toLowerCase();
  if (!buffer || !buffer.length) throw new Error('empty file');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('file too large (max 8 MB)');
  if (name.endsWith('.pdf') || buffer.subarray(0, 4).toString('ascii') === '%PDF') return parsePdf(buffer);
  if (name.endsWith('.docx')) return parseDocx(buffer);
  if (name.endsWith('.doc')) {
    if (buffer.subarray(0, 8).toString('hex') === '504b0304' + '0600' || buffer.subarray(0, 2).toString('ascii') === 'PK') {
      return parseDocx(buffer); // some ".doc" files are actually docx zips
    }
    return parseDoc(buffer);
  }
  if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.rtf')) {
    let text = buffer.toString('utf8');
    if (name.endsWith('.rtf')) text = text.replace(/\\[a-z]+-?\d* ?/g, ' ').replace(/[{}]/g, ' ');
    return { text: cleanText(text), warning: null };
  }
  throw new Error('unsupported format — upload .pdf, .docx, .doc, .txt or .md');
}

module.exports = { parseResume, cleanText };
