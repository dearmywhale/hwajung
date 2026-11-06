'use strict';
// 데이터베이스와 사진 저장소 연결
// - DATABASE_URL(또는 POSTGRES_URL)이 있으면 Postgres(Neon 등), 없으면 내장 Postgres(PGlite)를 DATA_DIR 에 저장
// - 사진: R2_* 환경 변수가 있으면 Cloudflare R2, 없으면 Vercel Blob(BLOB_READ_WRITE_TOKEN), 둘 다 없으면 DATA_DIR/photos 폴더
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

class ConfigError extends Error {}

// 연결 정보 찾기: 기본 이름이 없으면 접두어가 붙은 이름(예: STORAGE_DATABASE_URL)도 찾는다
function findEnv(preferred, test) {
  for (const k of preferred) if (process.env[k]) return process.env[k];
  const keys = Object.keys(process.env).sort();
  for (const k of keys) if (test(k, process.env[k] || '')) return process.env[k];
  return '';
}

function databaseUrl() {
  return findEnv(
    ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'],
    (k, v) => /^postgres(ql)?:\/\//.test(v) && /(DATABASE_URL|POSTGRES_URL)$/.test(k) && !/UNPOOLED|NON_POOLING/.test(k)
  ) || findEnv([], (k, v) => /^postgres(ql)?:\/\//.test(v) && /_URL$/.test(k));
}

function blobToken() {
  return findEnv(['BLOB_READ_WRITE_TOKEN'], (k, v) => /READ_WRITE_TOKEN$/.test(k) && /^vercel_blob_rw_/.test(v));
}

function envLabel() {
  return process.env.VERCEL_ENV ? ` (현재 배포 환경: ${process.env.VERCEL_ENV})` : '';
}

function normalizeSslMode(url) {
  try {
    const u = new URL(url);
    const mode = (u.searchParams.get('sslmode') || '').toLowerCase();
    if (['prefer', 'require', 'verify-ca'].includes(mode)) {
      u.searchParams.set('sslmode', 'verify-full');
      return u.toString();
    }
  } catch (e) { /* 주소 형식이 특이하면 그대로 사용 */ }
  return url;
}

async function openPostgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    // Neon 주소의 sslmode=require 를 현재와 같은 동작(인증서 확인)인 verify-full 로 명시 → 경고 제거
    connectionString: normalizeSslMode(url),
    max: process.env.VERCEL ? 3 : 10,
    idleTimeoutMillis: 10000,
  });
  const run = async (client, sql, params) => (await client.query(sql, params)).rows;
  return {
    kind: 'postgres',
    query: (sql, params = []) => run(pool, sql, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn((sql, params = []) => run(client, sql, params));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    // 여러 인스턴스가 동시에 시작해도 스키마 생성이 겹치지 않도록 잠금 후 실행
    async exec(sql) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(7272741)');
        await client.query(sql);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dir === ':memory:' ? new PGlite() : (fs.mkdirSync(dir, { recursive: true }), new PGlite(dir));
  await db.waitReady;
  // PGlite 는 한 번에 하나의 작업만 처리하므로 순서대로 실행
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  return {
    kind: 'pglite',
    query: (sql, params = []) => serial(async () => (await db.query(sql, params)).rows),
    tx: (fn) => serial(() => db.transaction((t) => fn(async (sql, params = []) => (await t.query(sql, params)).rows))),
    exec: (sql) => serial(() => db.exec(sql)),
    close: () => db.close(),
  };
}

async function openDatabase({ dataDir }) {
  const url = databaseUrl();
  if (url) return openPostgres(url);
  if (process.env.VERCEL) {
    throw new ConfigError('데이터베이스가 연결되지 않았습니다. Vercel 프로젝트의 Storage 탭에서 Neon(Postgres) 데이터베이스를 연결한 뒤 다시 배포해 주세요.' + envLabel());
  }
  return openPglite(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'pgdata'));
}

// ---------- 사진 저장소 ----------
// Cloudflare R2 설정 (S3 호환 API)
const R2_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
function r2Config() {
  const v = Object.fromEntries(R2_VARS.map((k) => [k, (process.env[k] || '').trim()]));
  const missing = R2_VARS.filter((k) => !v[k] && !(k === 'R2_ACCOUNT_ID' && process.env.R2_ENDPOINT));
  const anySet = R2_VARS.some((k) => v[k]) || !!process.env.R2_ENDPOINT;
  if (!anySet) return null;
  const endpoint = (process.env.R2_ENDPOINT || `https://${v.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  return { missing, endpoint, accessKeyId: v.R2_ACCESS_KEY_ID, secretAccessKey: v.R2_SECRET_ACCESS_KEY, bucket: v.R2_BUCKET };
}

// 새 사진은 R2 → (없으면) Vercel Blob → (로컬) 폴더 순으로 저장하고,
// 이미 저장된 사진은 주소 앞부분(r2: / blob- / file:)을 보고 해당 저장소에서 읽는다.
function openPhotoStore({ dataDir }) {
  const r2cfg = r2Config();
  const r2Incomplete = r2cfg && r2cfg.missing.length
    ? new ConfigError(`사진 저장소(Cloudflare R2) 설정이 덜 되었습니다. Vercel 환경 변수에 ${r2cfg.missing.join(', ')} 를 추가한 뒤 다시 배포해 주세요.` + envLabel())
    : null;
  const r2 = r2cfg && !r2Incomplete ? r2Store(r2cfg) : null;
  const token = blobToken();
  const blob = token ? blobStore(token) : null;
  const disk = process.env.VERCEL ? null : diskStore(path.join(dataDir, 'photos'));
  const primary = r2 || blob || disk;
  const pick = (ref) => {
    if (/^r2:/.test(ref)) return r2;
    if (/^file:/.test(ref)) return disk;
    return blob; // blob-private:/blob-public:/예전 주소
  };
  return {
    kind: primary ? primary.kind : 'missing',
    async put(key, buf, contentType) {
      if (r2Incomplete) throw r2Incomplete;
      if (!primary) throw new ConfigError('사진 저장소가 연결되지 않았습니다. 관리자에게 문의해 주세요. (Cloudflare R2 환경 변수 설정 필요)' + envLabel());
      return primary.put(key, buf, contentType);
    },
    async open(ref) {
      const store = ref && pick(ref);
      return store ? store.open(ref) : null;
    },
    async remove(refs) {
      for (const ref of refs.filter(Boolean)) {
        const store = pick(ref);
        if (store) await store.remove([ref]);
      }
    },
  };
}

function r2Store({ endpoint, accessKeyId, secretAccessKey, bucket }) {
  const { AwsClient } = require('aws4fetch');
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  const urlFor = (key) => `${endpoint}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const keyOf = (ref) => ref.replace(/^r2:/, '');
  async function failure(res, action) {
    const body = await res.text().catch(() => '');
    const code = (/<Code>([^<]+)<\/Code>/.exec(body) || [])[1] || '';
    console.error(`R2 ${action} failed`, res.status, code, body.slice(0, 300));
    if (res.status === 401 || res.status === 403 || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch') {
      return new ConfigError('사진 저장소(Cloudflare R2) 접근이 거부되었습니다. R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY 값과 토큰 권한(읽기·쓰기)을 확인해 주세요.');
    }
    if (code === 'NoSuchBucket') return new ConfigError(`R2 버킷 '${bucket}'을(를) 찾을 수 없습니다. R2_BUCKET 이름과 R2_ACCOUNT_ID를 확인해 주세요.`);
    return new Error(`R2 ${action} failed: ${res.status} ${code}`);
  }
  return {
    kind: 'r2',
    async put(key, buf, contentType) {
      const res = await client.fetch(urlFor(key), { method: 'PUT', body: buf, headers: { 'Content-Type': contentType } });
      if (!res.ok) throw await failure(res, 'upload');
      return 'r2:' + key;
    },
    async open(ref) {
      const res = await client.fetch(urlFor(keyOf(ref)));
      if (res.status === 404) return null;
      if (!res.ok) throw await failure(res, 'download');
      return Readable.fromWeb(res.body);
    },
    async remove(refs) {
      for (const ref of refs.filter(Boolean)) {
        const res = await client.fetch(urlFor(keyOf(ref)), { method: 'DELETE' }).catch((e) => { console.error('R2 delete failed', e); return null; });
        if (res && !res.ok && res.status !== 404) console.error('R2 delete failed', res.status);
      }
    },
  };
}

function diskStore(root) {
  fs.mkdirSync(root, { recursive: true });
  const resolve = (ref) => {
    const full = path.join(root, ref.replace(/^file:/, ''));
    if (!full.startsWith(root + path.sep)) throw new Error('bad path');
    return full;
  };
  return {
    kind: 'disk',
    async put(key, buf) {
      const full = path.join(root, key);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, buf);
      return 'file:' + key;
    },
    async open(ref) {
      const full = resolve(ref);
      if (!fs.existsSync(full)) return null;
      return fs.createReadStream(full);
    },
    async remove(refs) {
      for (const ref of refs.filter(Boolean)) await fs.promises.rm(resolve(ref), { force: true }).catch(() => {});
    },
  };
}

function blobStore(token) {
  const blob = require('@vercel/blob');
  // 비공개 저장소를 우선 사용하고, 공개 저장소로 만들어진 경우에도 동작하도록 한다.
  // 어느 경우든 사진 주소는 화면에 노출하지 않고 서버가 권한을 확인한 뒤 전달한다.
  let preferred = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
  const parse = (ref) => {
    const m = /^blob-(private|public):(.*)$/.exec(ref);
    return m ? { access: m[1], url: m[2] } : { access: 'public', url: ref };
  };
  return {
    kind: 'blob',
    async put(key, buf, contentType) {
      const opts = { contentType, addRandomSuffix: true, token };
      let res;
      try {
        res = await blob.put(key, buf, { ...opts, access: preferred });
      } catch (e) {
        const other = preferred === 'private' ? 'public' : 'private';
        if (!/access|private|public/i.test(String(e && e.message))) throw e;
        res = await blob.put(key, buf, { ...opts, access: other });
        preferred = other;
      }
      return `blob-${preferred}:${res.url}`;
    },
    async open(ref) {
      const { access, url } = parse(ref);
      const res = await blob.get(url, { access, token });
      if (!res || !res.stream) return null;
      return Readable.fromWeb(res.stream);
    },
    async remove(refs) {
      const urls = refs.filter(Boolean).map((r) => parse(r).url);
      if (urls.length) await blob.del(urls, { token }).catch((e) => console.error('blob delete failed', e));
    },
  };
}

function describeConfig() {
  return {
    environment: process.env.VERCEL_ENV || (process.env.VERCEL ? 'unknown' : 'local'),
    database: databaseUrl() ? '연결 정보 있음' : '연결 정보 없음',
    photos: (() => {
      const r2 = r2Config();
      if (r2) return r2.missing.length ? `Cloudflare R2 설정 부족 (${r2.missing.join(', ')})` : 'Cloudflare R2';
      return blobToken() ? 'Vercel Blob' : '연결 정보 없음';
    })(),
  };
}

module.exports = { openDatabase, openPhotoStore, ConfigError, describeConfig };
