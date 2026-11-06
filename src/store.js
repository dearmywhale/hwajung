'use strict';
// 데이터베이스와 사진 저장소 연결
// - DATABASE_URL(또는 POSTGRES_URL)이 있으면 Postgres(Neon 등), 없으면 내장 Postgres(PGlite)를 DATA_DIR 에 저장
// - BLOB_READ_WRITE_TOKEN 이 있으면 Vercel Blob, 없으면 DATA_DIR/photos 폴더에 저장
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

async function openPostgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url, // Neon 주소에는 sslmode=require 가 들어 있어 암호화 연결을 사용
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
function openPhotoStore({ dataDir }) {
  const token = blobToken();
  if (token) return blobStore(token);
  if (process.env.VERCEL) {
    const err = () => { throw new ConfigError('사진 저장소가 연결되지 않았습니다. 관리자에게 문의해 주세요. (Vercel Storage 탭에서 Blob 저장소 연결 필요)' + envLabel()); };
    return { kind: 'missing', put: err, open: err, remove: async () => {} };
  }
  return diskStore(path.join(dataDir, 'photos'));
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

module.exports = { openDatabase, openPhotoStore, ConfigError };
