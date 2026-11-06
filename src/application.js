'use strict';
const path = require('path');
const express = require('express');
const multer = require('multer');
const { openDatabase, openPhotoStore, ConfigError } = require('./store');
const { migrate, setTeam, currentTeamId } = require('./db');
const {
  ITEMS, kstToday, isValidDate, addDays, hashPin, verifyPin, isValidPin, cleanName,
  sha256, randomToken, sniffImage,
} = require('./util');
const stats = require('./stats');

const SESSION_COOKIE = 'hj_session';
const SESSION_DAYS = 60;
const MAX_PERIOD_DAYS = 400;
// Vercel 함수 요청 본문 한도(4.5MB)보다 작게
const MAX_UPLOAD = 4 * 1024 * 1024;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');

  // 데이터베이스는 첫 요청 때 연결 (서버리스 환경에서 인스턴스마다 한 번)
  let readyPromise = null;
  const state = { db: null, photos: null };
  function ready() {
    if (!readyPromise) {
      readyPromise = (async () => {
        const db = await openDatabase({ dataDir });
        try {
          await migrate(db);
        } catch (e) {
          console.error('database connection failed', e);
          await Promise.resolve(db.close()).catch(() => {});
          throw new ConfigError(`데이터베이스에 접속하지 못했습니다 (${e.code || e.name || '오류'}). Vercel Storage 탭에서 Neon 연결 상태를 확인해 주세요.`);
        }
        const seedName = cleanName(process.env.ADMIN_NAME || '');
        const seedPin = process.env.ADMIN_PIN || '';
        if (seedName && isValidPin(seedPin)) {
          const [{ n }] = await db.query('SELECT COUNT(*)::int AS n FROM users');
          if (n === 0) {
            const { hash, salt } = hashPin(seedPin);
            await db.query("INSERT INTO users (name, pin_hash, pin_salt, role) VALUES ($1, $2, $3, 'admin')", [seedName, hash, salt]);
          }
        }
        state.db = db;
        state.photos = openPhotoStore({ dataDir });
        return state;
      })();
      readyPromise.catch(() => { readyPromise = null; });
    }
    return readyPromise;
  }

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // async 핸들러 오류를 Express 오류 처리로 전달
  const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const q = (sql, params) => state.db.query(sql, params);
  const one = async (sql, params) => (await q(sql, params))[0];
  const tx = (fn) => state.db.tx(fn);

  const api = express.Router();
  // 배포 확인용: 어떤 버전이 실행 중이고 저장소 연결 정보가 있는지 (값은 보여 주지 않음)
  api.get('/health', (req, res) => {
    const { describeConfig } = require('./store');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, version: (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7), ...describeConfig() });
  });
  api.use(a(async (req, res, next) => { await ready(); next(); }));
  api.use(express.json({ limit: '100kb' }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 2 } });

  // ---------- 세션 ----------
  function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* 무시 */ }
    }
    return out;
  }

  function setSessionCookie(req, res, token, maxAgeSec) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
  }

  async function createSession(req, res, userId) {
    const token = randomToken();
    const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
    await q('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
    await q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), userId, expires]);
    setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  }

  api.use(a(async (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const row = await one(
        `SELECT u.id, u.name, u.role, u.active, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1`, [sha256(token)]);
      if (row && row.expires_at > Date.now() && row.active) {
        req.user = { id: row.id, name: row.name, role: row.role };
        req.sessionHash = sha256(token);
      }
    }
    next();
  }));

  // 상태 변경 요청은 이 사이트 화면에서 온 것만 허용 (CSRF 방지)
  api.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Requested-With') !== 'hwajung') return res.status(403).json({ error: '잘못된 요청입니다.' });
    next();
  });

  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: '로그인이 필요합니다.' }));
  const requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: '접근할 수 없습니다.' });
    next();
  };
  const fail = (res, status, error) => res.status(status).json({ error });

  // ---------- 로그인 ----------
  async function tooMany(key) {
    const row = await one('SELECT count, until_ms FROM login_attempts WHERE key = $1', [key]);
    return row && row.count >= 8 && row.until_ms > Date.now();
  }
  async function noteFail(key) {
    const now = Date.now();
    await q(`INSERT INTO login_attempts (key, count, until_ms) VALUES ($1, 1, $2)
             ON CONFLICT (key) DO UPDATE SET
               count = CASE WHEN login_attempts.until_ms < $3 THEN 1 ELSE login_attempts.count + 1 END,
               until_ms = CASE WHEN login_attempts.until_ms < $3 THEN $2 ELSE login_attempts.until_ms END`,
    [key, now + 10 * 60 * 1000, now]);
  }
  const userCount = async () => (await one('SELECT COUNT(*)::int AS n FROM users')).n;

  api.get('/setup-status', a(async (req, res) => {
    res.json({ needsSetup: (await userCount()) === 0 });
  }));

  api.post('/setup', a(async (req, res) => {
    const name = cleanName(req.body.name);
    const pin = String(req.body.pin || '');
    if (!name) return fail(res, 400, '이름을 입력해 주세요.');
    if (!isValidPin(pin)) return fail(res, 400, 'PIN은 숫자 4~8자리로 입력해 주세요.');
    const { hash, salt } = hashPin(pin);
    const id = await tx(async (t) => {
      await t('LOCK TABLE users IN EXCLUSIVE MODE');
      const [{ n }] = await t('SELECT COUNT(*)::int AS n FROM users');
      if (n > 0) return null;
      const [row] = await t("INSERT INTO users (name, pin_hash, pin_salt, role) VALUES ($1, $2, $3, 'admin') RETURNING id", [name, hash, salt]);
      return row.id;
    });
    if (!id) return fail(res, 409, '이미 관리자가 등록되어 있습니다.');
    await createSession(req, res, id);
    res.json({ ok: true });
  }));

  api.post('/login', a(async (req, res) => {
    const name = cleanName(req.body.name);
    const pin = String(req.body.pin || '');
    const key = (req.ip || '') + '|' + name.toLowerCase();
    if (await tooMany(key)) return fail(res, 429, '로그인 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.');
    const user = name ? await one('SELECT * FROM users WHERE lower(name) = lower($1)', [name]) : null;
    if (!user || !isValidPin(pin) || !verifyPin(pin, user.pin_salt, user.pin_hash)) {
      await noteFail(key);
      return fail(res, 401, '이름 또는 PIN이 올바르지 않습니다.');
    }
    if (!user.active) return fail(res, 403, '사용이 중지된 계정입니다. 관리자에게 문의해 주세요.');
    await q('DELETE FROM login_attempts WHERE key = $1 OR until_ms < $2', [key, Date.now()]);
    await createSession(req, res, user.id);
    res.json({ ok: true });
  }));

  api.post('/logout', a(async (req, res) => {
    if (req.sessionHash) await q('DELETE FROM sessions WHERE token_hash = $1', [req.sessionHash]);
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
  }));

  api.get('/me', requireUser, a(async (req, res) => {
    const teamId = await currentTeamId(q, req.user.id);
    const team = teamId ? await one('SELECT id, name FROM teams WHERE id = $1', [teamId]) : null;
    res.json({ user: { ...req.user, team: team || null }, today: kstToday() });
  }));

  api.post('/me/pin', requireUser, a(async (req, res) => {
    const user = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const current = String(req.body.current || '');
    const next = String(req.body.next || '');
    if (!verifyPin(current, user.pin_salt, user.pin_hash)) return fail(res, 400, '현재 PIN이 올바르지 않습니다.');
    if (!isValidPin(next)) return fail(res, 400, '새 PIN은 숫자 4~8자리로 입력해 주세요.');
    const { hash, salt } = hashPin(next);
    await q('UPDATE users SET pin_hash = $1, pin_salt = $2 WHERE id = $3', [hash, salt, user.id]);
    await q('DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2', [user.id, req.sessionHash]);
    res.json({ ok: true });
  }));

  // ---------- 오늘의 체크 (천국 한걸음) ----------
  async function checksFor(userId, date) {
    const rows = await q('SELECT id, item, updated_at FROM checks WHERE user_id = $1 AND date = $2', [userId, date]);
    const out = {};
    for (const i of ITEMS) out[i] = null;
    for (const r of rows) out[r.item] = { id: r.id, updatedAt: new Date(r.updated_at).getTime() };
    return out;
  }

  api.get('/me/today', requireUser, a(async (req, res) => {
    const today = kstToday();
    res.json({ date: today, checks: await checksFor(req.user.id, today) });
  }));

  function ensureToday(req, res) {
    const today = kstToday();
    if (!req.body || req.body.date !== today) {
      fail(res, 409, '날짜가 바뀌었습니다. 오늘 날짜의 체크만 할 수 있어요. 화면을 새로고침해 주세요.');
      return null;
    }
    return today;
  }

  api.post('/me/checks/:item', requireUser, (req, res, next) => {
    upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'thumb', maxCount: 1 }])(req, res, (err) => {
      if (err) return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? '사진 용량이 너무 큽니다 (최대 4MB). 다른 사진을 선택해 주세요.' : '사진을 올리지 못했습니다.');
      next();
    });
  }, a(async (req, res) => {
    const item = req.params.item;
    if (!ITEMS.includes(item)) return fail(res, 404, '없는 항목입니다.');
    const today = ensureToday(req, res);
    if (!today) return;
    const photo = req.files && req.files.photo && req.files.photo[0];
    if (!photo) return fail(res, 400, '사진을 첨부해 주세요.');
    const kind = sniffImage(photo.buffer);
    if (!kind) return fail(res, 400, '사진 파일(JPG, PNG, HEIC 등)만 올릴 수 있습니다.');
    const thumbFile = req.files.thumb && req.files.thumb[0];
    const thumbOk = thumbFile && (sniffImage(thumbFile.buffer) || {}).mime === 'image/jpeg';

    const base = `photos/${req.user.id}/${today}-${item}-${randomToken(6)}`;
    const photoRef = await state.photos.put(`${base}.${kind.ext}`, photo.buffer, kind.mime);
    const thumbRef = thumbOk ? await state.photos.put(`${base}-thumb.jpg`, thumbFile.buffer, 'image/jpeg') : null;
    const old = await one('SELECT * FROM checks WHERE user_id = $1 AND date = $2 AND item = $3', [req.user.id, today, item]);
    await q(`INSERT INTO checks (user_id, date, item, photo, thumb, mime) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, date, item) DO UPDATE SET photo = EXCLUDED.photo, thumb = EXCLUDED.thumb,
               mime = EXCLUDED.mime, updated_at = now()`,
    [req.user.id, today, item, photoRef, thumbRef, kind.mime]);
    if (old) await state.photos.remove([old.photo, old.thumb]);
    res.json({ date: today, checks: await checksFor(req.user.id, today) });
  }));

  api.delete('/me/checks/:item', requireUser, a(async (req, res) => {
    const item = req.params.item;
    if (!ITEMS.includes(item)) return fail(res, 404, '없는 항목입니다.');
    const today = ensureToday(req, res);
    if (!today) return;
    const [old] = await q('DELETE FROM checks WHERE user_id = $1 AND date = $2 AND item = $3 RETURNING photo, thumb', [req.user.id, today, item]);
    if (old) await state.photos.remove([old.photo, old.thumb]);
    res.json({ date: today, checks: await checksFor(req.user.id, today) });
  }));

  // 개인 기록
  api.get('/me/history', requireUser, a(async (req, res) => {
    const month = String(req.query.month || kstToday().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) return fail(res, 400, '잘못된 월입니다.');
    const rows = await q('SELECT id, date, item FROM checks WHERE user_id = $1 AND date LIKE $2 ORDER BY date', [req.user.id, month + '-%']);
    res.json({ month, today: kstToday(), checks: rows });
  }));

  // 사진 보기 — 본인 또는 관리자만
  api.get('/photos/:id', requireUser, a(async (req, res) => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? await one('SELECT * FROM checks WHERE id = $1', [id]) : null;
    if (!row || (row.user_id !== req.user.id && req.user.role !== 'admin')) return fail(res, 404, '사진을 찾을 수 없습니다.');
    const useThumb = req.query.thumb === '1' && row.thumb;
    const stream = await state.photos.open(useThumb ? row.thumb : row.photo);
    if (!stream) return fail(res, 404, '사진을 찾을 수 없습니다.');
    res.setHeader('Content-Type', useThumb ? 'image/jpeg' : row.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    stream.on('error', (e) => { console.error(e); res.destroy(); });
    stream.pipe(res);
  }));

  // ---------- 관리자: 성도 ----------
  const admin = express.Router();
  admin.use(requireAdmin);

  const adminCount = async (t, excludeId) =>
    (await t("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND active AND id != $1", [excludeId || 0]))[0].n;
  const getUser = async (id) => (Number.isInteger(Number(id)) ? one('SELECT * FROM users WHERE id = $1', [Number(id)]) : null);
  const getTeam = async (id) => (Number.isInteger(Number(id)) ? one('SELECT * FROM teams WHERE id = $1', [Number(id)]) : null);
  const nameTaken = async (name, exceptId) => !!(await one('SELECT id FROM users WHERE lower(name) = lower($1) AND id != $2', [name, exceptId || 0]));
  const liveTeam = async (teamId) => { const t = await getTeam(teamId); if (!t || t.deleted_at) throw new HttpError(400, '팀을 찾을 수 없습니다.'); return t; };

  admin.get('/users', a(async (req, res) => {
    const users = await q(
      `SELECT u.id, u.name, u.role, u.active, u.created_at, m.team_id, t.name AS team_name,
              (SELECT COUNT(*)::int FROM checks c WHERE c.user_id = u.id AND c.date = $1) AS today_count
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.end_date IS NULL
       LEFT JOIN teams t ON t.id = m.team_id
       ORDER BY u.active DESC, lower(u.name)`, [kstToday()]);
    res.json({ users });
  }));

  admin.post('/users', a(async (req, res) => {
    const name = cleanName(req.body.name);
    const pin = String(req.body.pin || '');
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    const teamId = req.body.teamId ? Number(req.body.teamId) : null;
    if (!name) return fail(res, 400, '이름을 입력해 주세요.');
    if (!isValidPin(pin)) return fail(res, 400, 'PIN은 숫자 4~8자리로 입력해 주세요.');
    if (await nameTaken(name)) return fail(res, 409, '같은 이름의 성도가 이미 있습니다. 구분할 수 있게 이름을 바꿔 주세요.');
    if (teamId) await liveTeam(teamId);
    const { hash, salt } = hashPin(pin);
    const id = await tx(async (t) => {
      const [row] = await t('INSERT INTO users (name, pin_hash, pin_salt, role) VALUES ($1, $2, $3, $4) RETURNING id', [name, hash, salt, role]);
      if (teamId) await setTeam(t, row.id, teamId);
      return row.id;
    });
    res.json({ ok: true, id });
  }));

  admin.patch('/users/:id', a(async (req, res) => {
    const user = await getUser(req.params.id);
    if (!user) return fail(res, 404, '성도를 찾을 수 없습니다.');
    const name = req.body.name !== undefined ? cleanName(req.body.name) : user.name;
    const role = req.body.role !== undefined ? (req.body.role === 'admin' ? 'admin' : 'member') : user.role;
    if (!name) return fail(res, 400, '이름을 입력해 주세요.');
    if (await nameTaken(name, user.id)) return fail(res, 409, '같은 이름의 성도가 이미 있습니다.');
    if (user.role === 'admin' && role !== 'admin' && (await adminCount(q, user.id)) === 0) return fail(res, 400, '관리자는 최소 한 명 있어야 합니다.');
    await q('UPDATE users SET name = $1, role = $2 WHERE id = $3', [name, role, user.id]);
    res.json({ ok: true });
  }));

  admin.put('/users/:id/team', a(async (req, res) => {
    const user = await getUser(req.params.id);
    if (!user) return fail(res, 404, '성도를 찾을 수 없습니다.');
    const teamId = req.body.teamId ? Number(req.body.teamId) : null;
    if (teamId) await liveTeam(teamId);
    if (!user.active && teamId) return fail(res, 400, '비활성화된 성도는 팀에 배정할 수 없습니다. 먼저 활성화해 주세요.');
    await tx((t) => setTeam(t, user.id, teamId));
    res.json({ ok: true });
  }));

  admin.post('/users/:id/active', a(async (req, res) => {
    const user = await getUser(req.params.id);
    if (!user) return fail(res, 404, '성도를 찾을 수 없습니다.');
    const active = !!req.body.active;
    if (!active && user.id === req.user.id) return fail(res, 400, '자기 자신은 비활성화할 수 없습니다.');
    if (!active && user.role === 'admin' && (await adminCount(q, user.id)) === 0) return fail(res, 400, '관리자는 최소 한 명 있어야 합니다.');
    await tx(async (t) => {
      if (!active && user.active) {
        const teamId = await currentTeamId(t, user.id);
        await t('UPDATE users SET active = FALSE, last_team_id = $1 WHERE id = $2', [teamId, user.id]);
        await setTeam(t, user.id, null);
        await t('DELETE FROM sessions WHERE user_id = $1', [user.id]);
      } else if (active && !user.active) {
        await t('UPDATE users SET active = TRUE WHERE id = $1', [user.id]);
        if (user.last_team_id) {
          const [team] = await t('SELECT id FROM teams WHERE id = $1 AND deleted_at IS NULL', [user.last_team_id]);
          if (team) await setTeam(t, user.id, team.id);
        }
      }
    });
    res.json({ ok: true });
  }));

  admin.post('/users/:id/pin', a(async (req, res) => {
    const user = await getUser(req.params.id);
    if (!user) return fail(res, 404, '성도를 찾을 수 없습니다.');
    const pin = String(req.body.pin || '');
    if (!isValidPin(pin)) return fail(res, 400, 'PIN은 숫자 4~8자리로 입력해 주세요.');
    const { hash, salt } = hashPin(pin);
    await q('UPDATE users SET pin_hash = $1, pin_salt = $2 WHERE id = $3', [hash, salt, user.id]);
    if (user.id !== req.user.id) await q('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    res.json({ ok: true });
  }));

  admin.delete('/users/:id', a(async (req, res) => {
    const user = await getUser(req.params.id);
    if (!user) return fail(res, 404, '성도를 찾을 수 없습니다.');
    if (user.id === req.user.id) return fail(res, 400, '자기 자신은 삭제할 수 없습니다.');
    if (user.role === 'admin' && (await adminCount(q, user.id)) === 0) return fail(res, 400, '관리자는 최소 한 명 있어야 합니다.');
    const files = await tx(async (t) => {
      const rows = await t('DELETE FROM checks WHERE user_id = $1 RETURNING photo, thumb', [user.id]);
      await t('DELETE FROM memberships WHERE user_id = $1', [user.id]);
      await t('DELETE FROM sessions WHERE user_id = $1', [user.id]);
      await t('DELETE FROM users WHERE id = $1', [user.id]);
      return rows.flatMap((r) => [r.photo, r.thumb]);
    });
    await state.photos.remove(files);
    res.json({ ok: true });
  }));

  // ---------- 관리자: 팀 ----------
  admin.get('/teams', a(async (req, res) => {
    const teams = await q('SELECT id, name, deleted_at FROM teams ORDER BY id');
    const members = await q(
      `SELECT m.team_id, u.id, u.name, u.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.end_date IS NULL ORDER BY lower(u.name)`);
    const byTeam = new Map();
    for (const m of members) {
      if (!byTeam.has(m.team_id)) byTeam.set(m.team_id, []);
      byTeam.get(m.team_id).push({ id: m.id, name: m.name, role: m.role });
    }
    res.json({
      teams: teams.filter((t) => !t.deleted_at).map((t) => ({ id: t.id, name: t.name, members: byTeam.get(t.id) || [] })),
      deletedTeams: teams.filter((t) => t.deleted_at).map((t) => ({ id: t.id, name: t.name, deletedAt: kstToday(new Date(t.deleted_at).getTime()) })),
    });
  }));

  const teamNameTaken = async (name, exceptId) =>
    !!(await one('SELECT id FROM teams WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id != $2', [name, exceptId || 0]));

  admin.post('/teams', a(async (req, res) => {
    const name = cleanName(req.body.name);
    if (!name) return fail(res, 400, '팀 이름을 입력해 주세요.');
    if (await teamNameTaken(name)) return fail(res, 409, '같은 이름의 팀이 이미 있습니다.');
    const [row] = await q('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name]);
    res.json({ ok: true, id: row.id });
  }));

  admin.patch('/teams/:id', a(async (req, res) => {
    const team = await getTeam(req.params.id);
    if (!team) return fail(res, 404, '팀을 찾을 수 없습니다.');
    const name = cleanName(req.body.name);
    if (!name) return fail(res, 400, '팀 이름을 입력해 주세요.');
    if (await teamNameTaken(name, team.id)) return fail(res, 409, '같은 이름의 팀이 이미 있습니다.');
    await q('UPDATE teams SET name = $1 WHERE id = $2', [name, team.id]);
    res.json({ ok: true });
  }));

  admin.delete('/teams/:id', a(async (req, res) => {
    const team = await getTeam(req.params.id);
    if (!team || team.deleted_at) return fail(res, 404, '팀을 찾을 수 없습니다.');
    await tx(async (t) => {
      const open = await t('SELECT user_id FROM memberships WHERE team_id = $1 AND end_date IS NULL', [team.id]);
      for (const m of open) await setTeam(t, m.user_id, null);
      await t('UPDATE teams SET deleted_at = now() WHERE id = $1', [team.id]);
    });
    res.json({ ok: true });
  }));

  admin.post('/teams/:id/restore', a(async (req, res) => {
    const team = await getTeam(req.params.id);
    if (!team || !team.deleted_at) return fail(res, 404, '팀을 찾을 수 없습니다.');
    if (await teamNameTaken(team.name, team.id)) return fail(res, 409, '같은 이름의 팀이 이미 있어 복구할 수 없습니다. 기존 팀 이름을 먼저 바꿔 주세요.');
    await q('UPDATE teams SET deleted_at = NULL WHERE id = $1', [team.id]);
    res.json({ ok: true });
  }));

  admin.post('/teams/:id/members', a(async (req, res) => {
    const team = await getTeam(req.params.id);
    if (!team || team.deleted_at) return fail(res, 404, '팀을 찾을 수 없습니다.');
    const ids = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return fail(res, 400, '추가할 성도를 선택해 주세요.');
    await tx(async (t) => {
      for (const id of ids) {
        const [u] = await t('SELECT id FROM users WHERE id = $1 AND active', [id]);
        if (u) await setTeam(t, u.id, team.id);
      }
    });
    res.json({ ok: true });
  }));

  // ---------- 관리자: 통계 ----------
  function readPeriod(req) {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end)) throw new HttpError(400, '기간을 올바르게 입력해 주세요.');
    if (start > end) throw new HttpError(400, '시작일이 종료일보다 늦습니다.');
    if (addDays(start, MAX_PERIOD_DAYS) < end) throw new HttpError(400, `기간은 최대 ${MAX_PERIOD_DAYS}일까지 조회할 수 있습니다.`);
    return { start, end };
  }

  admin.get('/stats', a(async (req, res) => {
    const p = readPeriod(req);
    res.json(await stats.overview(state.db, p.start, p.end));
  }));

  admin.get('/stats/team/:id', a(async (req, res) => {
    const p = readPeriod(req);
    const id = Number(req.params.id);
    const d = Number.isInteger(id) ? await stats.teamDetail(state.db, id, p.start, p.end) : null;
    if (!d) return fail(res, 404, '팀을 찾을 수 없습니다.');
    res.json(d);
  }));

  admin.get('/stats.csv', a(async (req, res) => {
    const p = readPeriod(req);
    const csv = await stats.statsCsv(state.db, p.start, p.end);
    const fname = `화정찬양부_통계_${p.start}_${p.end}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hwajung_stats_${p.start}_${p.end}.csv"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(csv);
  }));

  // ---------- 관리자: 사진 확인 ----------
  admin.get('/photos', a(async (req, res) => {
    const p = readPeriod(req);
    const params = [p.start, p.end];
    let sql = `SELECT c.id, c.user_id, u.name AS user_name, c.date, c.item, (c.thumb IS NOT NULL) AS has_thumb
               FROM checks c JOIN users u ON u.id = c.user_id WHERE c.date >= $1 AND c.date <= $2`;
    if (req.query.userId && Number.isInteger(Number(req.query.userId))) { params.push(Number(req.query.userId)); sql += ` AND c.user_id = $${params.length}`; }
    if (ITEMS.includes(req.query.item)) { params.push(req.query.item); sql += ` AND c.item = $${params.length}`; }
    sql += ` ORDER BY c.date DESC, lower(u.name), CASE c.item WHEN 'prayer' THEN 1 WHEN 'weclick' THEN 2 ELSE 3 END LIMIT 2001`;
    const rows = await q(sql, params);
    res.json({ photos: rows.slice(0, 2000), truncated: rows.length > 2000 });
  }));

  api.use('/admin', admin);
  api.use((req, res) => fail(res, 404, '없는 주소입니다.'));

  app.use('/api', api);

  // ---------- 화면 ----------
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (res.headersSent) return;
    if (err instanceof HttpError) return fail(res, err.status, err.message);
    if (err instanceof ConfigError) return fail(res, 503, err.message);
    if (err && err.type === 'entity.parse.failed') return fail(res, 400, '잘못된 요청입니다.');
    console.error(err);
    fail(res, 500, '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  });

  app.locals.ready = ready;
  return app;
}

module.exports = { createApp };
