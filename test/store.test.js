'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');

// Vercel Blob 저장소 동작 확인 (실제 서비스 대신 가짜 모듈 사용)
test('Vercel Blob: 비공개 우선, 공개 저장소면 자동 전환, 읽기/삭제', async () => {
  const stored = new Map();
  const calls = [];
  const fake = {
    async put(key, buf, opts) {
      calls.push(['put', opts.access]);
      if (opts.access === 'private' && fake.storeIsPublic) throw new Error('Cannot use private access on a public store');
      const url = `https://x.blob.vercel-storage.com/${key}-rand`;
      stored.set(url, buf);
      return { url };
    },
    async get(url, opts) {
      calls.push(['get', opts.access]);
      const b = stored.get(url);
      return b ? { statusCode: 200, stream: Readable.toWeb(Readable.from([b])) } : null;
    },
    async del(urls) { for (const u of urls) stored.delete(u); },
    storeIsPublic: true,
  };
  require.cache[require.resolve('@vercel/blob')] = { exports: fake, loaded: true, id: require.resolve('@vercel/blob') };
  process.env.BLOB_READ_WRITE_TOKEN = 'test';
  delete require.cache[require.resolve('../src/store')];
  const { openPhotoStore } = require('../src/store');
  const store = openPhotoStore({ dataDir: '/nonexistent' });
  assert.equal(store.kind, 'blob');
  const ref = await store.put('photos/1/a.jpg', Buffer.from('hello'), 'image/jpeg');
  assert.match(ref, /^blob-public:https:/);
  const s = await store.open(ref);
  const chunks = []; for await (const c of s) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'hello');
  await store.remove([ref, null]);
  assert.equal(stored.size, 0);
  assert.deepEqual(calls.map((c) => c.join(':')), ['put:private', 'put:public', 'get:public']);
  delete process.env.BLOB_READ_WRITE_TOKEN;
});
