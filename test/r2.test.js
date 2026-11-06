'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Cloudflare R2 대신 S3 형식으로 응답하는 가짜 서버
const objects = new Map();
const seen = [];
let fake;
before(async () => {
  fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', type: req.headers['content-type'] });
      if (!/^AWS4-HMAC-SHA256 Credential=testkey\/\d{8}\/auto\/s3\/aws4_request/.test(req.headers.authorization || '')) {
        res.writeHead(403); return res.end('<Error><Code>InvalidAccessKeyId</Code></Error>');
      }
      if (!req.url.startsWith('/hwajung-photos/')) { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
      if (req.method === 'PUT') { objects.set(req.url, { body: Buffer.concat(chunks), type: req.headers['content-type'] }); res.writeHead(200); return res.end(); }
      if (req.method === 'GET') {
        const o = objects.get(req.url);
        if (!o) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
        res.writeHead(200, { 'Content-Type': o.type }); return res.end(o.body);
      }
      if (req.method === 'DELETE') { objects.delete(req.url); res.writeHead(204); return res.end(); }
      res.writeHead(400); res.end();
    });
  });
  await new Promise((r) => fake.listen(0, r));
});
after(() => fake.close());

function setEnv(env) {
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT', 'BLOB_READ_WRITE_TOKEN']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/store')];
  return require('../src/store');
}

test('R2: 업로드 · 읽기 · 삭제 (서명된 요청)', async () => {
  const { openPhotoStore, describeConfig } = setEnv({
    R2_ENDPOINT: `http://127.0.0.1:${fake.address().port}`, R2_ACCESS_KEY_ID: 'testkey', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'hwajung-photos',
  });
  assert.equal(describeConfig().photos, 'Cloudflare R2');
  const store = openPhotoStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hj-r2-')) });
  assert.equal(store.kind, 'r2');
  const ref = await store.put('photos/3/2026-11-06-prayer-abc.jpg', Buffer.from('jpegdata'), 'image/jpeg');
  assert.equal(ref, 'r2:photos/3/2026-11-06-prayer-abc.jpg');
  assert.equal(seen.at(-1).url, '/hwajung-photos/photos/3/2026-11-06-prayer-abc.jpg');
  assert.equal(seen.at(-1).type, 'image/jpeg');
  const s = await store.open(ref);
  const chunks = []; for await (const c of s) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'jpegdata');
  assert.equal(await store.open('r2:photos/none.jpg'), null);
  await store.remove([ref]);
  assert.equal(objects.size, 0);
});

test('R2: 잘못된 키·버킷은 알아보기 쉬운 안내', async () => {
  let { openPhotoStore } = setEnv({
    R2_ENDPOINT: `http://127.0.0.1:${fake.address().port}`, R2_ACCESS_KEY_ID: 'wrong', R2_SECRET_ACCESS_KEY: 'x', R2_BUCKET: 'hwajung-photos',
  });
  await assert.rejects(openPhotoStore({ dataDir: os.tmpdir() }).put('a.jpg', Buffer.from('x'), 'image/jpeg'), /접근이 거부/);
  ({ openPhotoStore } = setEnv({
    R2_ENDPOINT: `http://127.0.0.1:${fake.address().port}`, R2_ACCESS_KEY_ID: 'testkey', R2_SECRET_ACCESS_KEY: 'x', R2_BUCKET: 'other',
  }));
  await assert.rejects(openPhotoStore({ dataDir: os.tmpdir() }).put('a.jpg', Buffer.from('x'), 'image/jpeg'), /버킷 'other'/);
});

test('R2: 설정이 일부만 있으면 빠진 항목 안내', async () => {
  const { openPhotoStore, describeConfig } = setEnv({ R2_ACCOUNT_ID: 'abc', R2_BUCKET: 'b' });
  assert.match(describeConfig().photos, /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);
  await assert.rejects(openPhotoStore({ dataDir: os.tmpdir() }).put('a.jpg', Buffer.from('x'), 'image/jpeg'), /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);
  setEnv({});
});
