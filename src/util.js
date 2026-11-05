'use strict';
const crypto = require('crypto');

const ITEMS = ['prayer', 'weclick', 'word'];
const ITEM_LABELS = { prayer: '기도', weclick: '위클릭', word: '3분말씀' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 한국 시간(KST, UTC+9, 서머타임 없음) 기준 오늘 날짜
function kstToday(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const out = [];
  if (start > end) return out;
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

function minDate(a, b) { return a < b ? a : b; }
function maxDate(a, b) { return a > b ? a : b; }

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { hash, salt };
}

function verifyPin(pin, salt, hash) {
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(pin), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === h.length && crypto.timingSafeEqual(h, expected);
}

function isValidPin(pin) {
  return typeof pin === 'string' && /^\d{4,8}$/.test(pin);
}

function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/\s+/g, ' ').trim().slice(0, 40);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// 업로드된 파일의 실제 형식을 앞부분 바이트로 확인
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (buf.toString('latin1', 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif'].includes(brand)) {
      return { mime: 'image/heic', ext: 'heic' };
    }
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif' };
  }
  return null;
}

module.exports = {
  ITEMS, ITEM_LABELS, kstToday, isValidDate, addDays, dateRange, minDate, maxDate,
  hashPin, verifyPin, isValidPin, cleanName, sha256, randomToken, sniffImage,
};
