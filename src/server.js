'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { openDb, setTeam, currentTeamId } = require('./db');
const {
  ITEMS, kstToday, isValidDate, addDays, hashPin, verifyPin, isValidPin, cleanName,
  sha256, randomToken, sniffImage,
} = require('./util');
const stats = require('./stats');

const SESSION_COOKIE = 'hj_session';
const SESSION_DAYS = 60;
const MAX_PERIOD_DAYS = 400;

function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const photoDir = path.join(dataDir, 'photos');
  const db = openDb(dataDir);

  // 환경 변수로 첫 관리자 생성 (선택)
  const seedName = cleanName(process.env.ADMIN_NAME || '');
  const seedPin = process.env.ADMIN_PIN || '';
  if (seedName && isValidPin(seedPin) && db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
    const { hash, salt } = hashPin(seedPin);
    db.prepare("INSERT INTO users (name, pin_hash, pin_salt, role) VALUES (?, ?, ?, 'admin')").run(seedName, hash, salt);
  }

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 2 },
  });

  // ---------- 세션 ----------
  function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function setSessionCookie(req, res, token, maxAgeSec) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
  }

  function createSession(req, res, userId) {
    const token = randomToken();
    const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
    setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  }

  app.use((req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const row = db.prepare(
        `SELECT u.id, u.name, u.role, u.active, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      ).get(sha256(token));
      if (row && row.expires_at > Date.now() && row.active) {
        req.user = { id: row.id, name: row.name, role: row.role };
        req.sessionHash = sha256(token);
      }
    }
    next();
  });

  // 상태 변경 요청은 같은 사이트에서 온 것만 허용 (CSRF 방지)
  app.use('/api', (req, res, next) => {
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
  const attempts = new Map(); // key -> {count, until}
  function tooMany(key) {
    const a = attempts.get(key);
    return a && a.count >= 8 && a.until > Date.now();
  }
  function noteFail(key) {
    const a = attempts.get(key);
    if (!a || a.until < Date.now()) attempts.set(key, { count: 1, until: Date.now() + 10 * 60 * 1000 });
    else a.count++;
  }

  app.get('/api/setup-status', (req, res) => {
    res.json({ needsSetup: db.prepare('SELECT COUNT(*) n FROM users').get().n === 0 });
  });

  app.post('/api/setup', (req, res) => {
    const name = cleanName(req.body.name);
    const pin = String(req.body.pin || '');
    if (!name) return fail(res, 400, '이름을 입력해 주세요.');
    if (!isValidPin(pin)) return fail(res, 400, 'PIN은 숫자 4~8자리로 입력해 주세요.');
    const created = db.transaction(() => {
      if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) return null;
      const { hash, salt } = hashPin(pin);
      return db.prepare("INSERT INTO users (name, pin_hash, pin_salt, role) VALUES (?, ?, ?, 'admin')").run(name, hash, salt).lastInsertRowid;
    })();
    if (!created) return fail(res, 409, '이미 관리자가 등록되어 있습니다.');
    createSession(req, res, created);
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const name = cleanName(req.body.name);
    const pin = String(req.body.pin || '');
    const key = (req.ip || '') + '|' + name.toLowerCase();
    if (tooMany(key)) return fail(res, 429, '로그인 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.');
    const user = name ? db.prepare('SELECT * FROM users WHERE name = ?').get(name) : null;
    if (!user || !isValidPin(pin) || !verifyPin(pin, user.pin_salt, user.pin_hash)) {
      noteFail(key);
      return fail(res, 401, '이름 또는 PIN이 올바르지 않습니다.');
    }
    if (!user.active) return fail(res, 403, '사용이 중지된 계정입니다. 관리자에게 문의해 주세요.');
    attempts.delete(key);
    createSession(req, res, user.id);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => {
    const teamId = currentTeamId(db, req.user.id);
    const team = teamId ? db.prepare('SELECT id, name FROM teams WHERE id = ?').get(teamId) : null;
    res.json({ user: { ...req.user, team }, today: kstToday() });
  });

  app.post('/api/me/pin', requireUser, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const current = String(req.body.current || '');
    const next = String(req.body.next || '');
    if (!verifyPin(current, user.pin_salt, user.pin_hash)) return fail(res, 400, '현재 PIN이 올바르지 않습니다.');
    if (!isValidPin(next)) return fail(res, 400, '새 PIN은 숫자 4~8자리로 입력해 주세요.');
    const { hash, salt } = hashPin(next);
    db.prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hash, salt, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, req.sessionHash);
    res.json({ ok: true });
  });

  // ---------- 사진 파일 ----------
  function savePhotoFile(userId, buf, ext) {
    const dir = path.join(photoDir, String(userId));
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.join(String(userId), `${Date.now()}-${randomToken(9)}.${ext}`);
    fs.writeFileSync(path.join(photoDir, rel), buf);
    return rel;
  }
  function removePhotoFile(rel) {
    if (!rel) return;
    const full = path.join(photoDir, rel);
    if (!full.startsWith(photoDir + path.sep)) return;
    fs.rm(full, { force: true }, () => {});
  }

  // ---------- 오늘의 체크 (천국 한걸음) ----------
  function checksFor(userId, date) {
    const rows = db.prepare('SELECT id, item, updated_at FROM checks WHERE user_id = ? AND date = ?').all(userId, date);
    const out = {};
    for (const i of ITEMS) out[i] = null;
    for (const r of rows) out[r.item] = { id: r.id, updatedAt: r.updated_at };
    return out;
  }

  app.get('/api/me/today', requireUser, (req, res) => {
    const today = kstToday();
    res.json({ date: today, checks: checksFor(req.user.id, today) });
  });

  function ensureToday(req, res) {
    const today = kstToday();
    const date = req.body && req.body.date;
    if (date !== today) {
      fail(res, 409, '날짜가 바뀌었습니다. 오늘 날짜의 체크만 할 수 있어요. 화면을 새로고침해 주세요.');
      return null;
    }
    return today;
  }

  app.post('/api/me/checks/:item', requireUser, (req, res, next) => {
    upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'thumb', maxCount: 1 }])(req, res, (err) => {
      if (err) return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? '사진 용량이 너무 큽니다 (최대 15MB).' : '사진을 올리지 못했습니다.');
      next();
    });
  }, (req, res) => {
    const item = req.params.item;
    if (!ITEMS.includes(item)) return fail(res, 404, '없는 항목입니다.');
    const today = ensureToday(req, res);
    if (!today) return;
    const photo = req.files && req.files.photo && req.files.photo[0];
    if (!photo) return fail(res, 400, '사진을 첨부해 주세요.');
    const kind = sniffImage(photo.buffer);
    if (!kind) return fail(res, 400, '사진 파일(JPG, PNG, HEIC 등)만 올릴 수 있습니다.');
    const thumbFile = req.files.thumb && req.files.thumb[0];
    const thumbKind = thumbFile ? sniffImage(thumbFile.buffer) : null;

    const photoRel = savePhotoFile(req.user.id, photo.buffer, kind.ext);
    const thumbRel = thumbKind && thumbKind.mime === 'image/jpeg' ? savePhotoFile(req.user.id, thumbFile.buffer, 'thumb.jpg') : null;
    const old = db.prepare('SELECT * FROM checks WHERE user_id = ? AND date = ? AND item = ?').get(req.user.id, today, item);
    if (old) {
      db.prepare("UPDATE checks SET photo = ?, thumb = ?, mime = ?, updated_at = datetime('now') WHERE id = ?")
        .run(photoRel, thumbRel, kind.mime, old.id);
      removePhotoFile(old.photo); removePhotoFile(old.thumb);
    } else {
      db.prepare('INSERT INTO checks (user_id, date, item, photo, thumb, mime) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.user.id, today, item, photoRel, thumbRel, kind.mime);
    }
    res.json({ date: today, checks: checksFor(req.user.id, today) });
  });

  app.delete('/api/me/checks/:item', requireUser, (req, res) => {
    const item = req.params.item;
    if (!ITEMS.includes(item)) return fail(res, 404, '없는 항목입니다.');
    const today = ensureToday(req, res);
    if (!today) return;
    const old = db.prepare('SELECT * FROM checks WHERE user_id = ? AND date = ? AND item = ?').get(req.user.id, today, item);
    if (old) {
      db.prepare('DELETE FROM checks WHERE id = ?').run(old.id);
      removePhotoFile(old.photo); removePhotoFile(old.thumb);
    }
    res.json({ date: today, checks: checksFor(req.user.id, today) });
  });

  // 개인 기록
  app.get('/api/me/history', requireUser, (req, res) => {
    const month = String(req.query.month || kstToday().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) return fail(res, 400, '잘못된 월입니다.');
    const rows = db.prepare(
      "SELECT id, date, item FROM checks WHERE user_id = ? AND date LIKE ? ORDER BY date"
    ).all(req.user.id, month + '-%');
    const first = month + '-01';
    const last = addDays(addDays(first, 32).slice(0, 7) + '-01', -1);
    const ms = db.prepare(
      `SELECT m.start_date, m.end_date FROM memberships m WHERE m.user_id = ? AND m.start_date <= ? AND (m.end_date IS NULL OR m.end_date >= ?)`
    ).all(req.user.id, last, first);
    res.json({ month, today: kstToday(), checks: rows, memberships: ms });
  });

  // 사진 보기 — 본인 또는 관리자만
  app.get('/api/photos/:id', requireUser, (req, res) => {
    const row = db.prepare('SELECT * FROM checks WHERE id = ?').get(Number(req.params.id));
    if (!row || (row.user_id !== req.user.id && req.user.role !== 'admin')) return fail(res, 404, '사진을 찾을 수 없습니다.');
    const useThumb = req.query.thumb === '1' && row.thumb;
    const rel = useThumb ? row.thumb : row.photo;
    const full = path.join(photoDir, rel);
    if (!full.startsWith(photoDir + path.sep) || !fs.existsSync(full)) return fail(res, 404, '사진을 찾을 수 없습니다.');
    res.setHeader('Content-Type', useThumb ? 'image/jpeg' : row.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    fs.createReadStream(full).pipe(res);
  });

  // ---------- 관리자: 성도 ----------
  const admin = express.Router();
  admin.use(requireAdmin);

  function adminCount(excludeId) {
    return db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(excludeId || 0).n;
  }
  function getUser(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)); }
  function getTeam(id) { return db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(id)); }
  function nameTaken(name, exceptId) {
    return !!db.prepare('SELECT id FROM users WHERE name = ? AND id != ?').get(name, exceptId || 0);
  }

  admin.get('/users', (req, res) => {
    const today = kstToday();
    const users = db.prepare(
      `SELECT u.id, u.name, u.role, u.active, u.created_at, m.team_id, t.name AS team_name,
              (SELECT COUNT(*) FROM checks c WHERE c.user_id = u.id AND c.date = ?) AS today_count
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.end_date IS NULL
       LEFT JOIN teams t ON t.id = m.team_id
       ORDER BY u.active DESC, u.name COLLATE NOCASE`
    ).all(today);
    res.json({ users: users.map((u) => ({ ...u, active: !!u.active })) });
  });

  admin.post('/users', (req, res) => {
    const name = cleanName(req.body.name);
    const pin = String(req.body.pin || '');
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    const teamId = req.body.teamId ? Number(req.body.teamId) : null;
    if (!name) return fail(res, 400, '이름을 입력해 주세요.');
    if (!isValidPin(pin)) return fail(res, 400, 'PIN은 숫자 4~8자리로 입력해 주세요.');
    if (nameTaken(name)) return fail(res, 409, '같은 이름의 성도가 이미 있습니다. 구분할 수 있게 이름을 바꿔 주세요.');
    if (teamId) { const t = getTeam(teamId); if (!t || t.deleted_at) return fail(res, 400, '팀을 찾을 수 없습니다.'); }
    const { hash, salt } = hashPin(pin);
    const id = db.transaction(() => {
      const newId = db.prepare('INSERT INTO users (name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?)').run(name, hash, salt, role).lastInsertRowid;
      if (teamId) setTeam(db, newId, teamId);
      return newId;
    })();
    res.json({ ok: true, id });
  });

  admin.patch('/users/:id', (req, res) => {
    const user = getUser(req.params.id);
    if (!user) return fail(res, 404, '성도를 찾을 수 없습니다.');
    const name = req.body.name !== undefined ? cleanName(req.body.name) : user.name;
    const role = req.body.role !== undefined ? (req.body.role === 'admin' ? 'admin' : 'member') : user.role;
    if (!name) return fail(res, 400, '이름을 입력해 주세요.');
    if (nameTaken(name, user.id)) return fail(res, 409, '같은 이름의 성도가 이미 있습니다.');
    if (user.role === 'admin' && role !== 'admin' && adminCount(user.id) === 0) return fail(res, 400, '관리자는 최소 한 명 있어야 합니다.');
    db.prepare('UPDATE users SET name = ?, role = ? WHERE id = ?').run(name, role, user.id);
    res.json({ ok: true });
  });

  admin.put('/users/:id/team', (req, res) => {
    const user = getUser(req.params.id);
    if (!user) return fail(res, 404, '성도를 찾을 수 없습니다.');
    const teamId = req.body.teamId ? Number(req.body.teamId) : null;
    if (teamId) { const t = getTeam(teamId); if (!t || t.deleted_at) return fail(res, 400, '팀을 찾을 수 없습니다.'); }
    if (!user.active && teamId) return fail(res, 400, '비활성화된 성도는 팀에 배정할 수 없습니다. 먼저 활성화해 주세요.');
    db.transaction(() => setTeam(db, user.id, teamId))();
    res.json({ ok: true });
  });

  admin.post('/users/:id/active', (req, res) => {
    const user = getUser(req.params.id);
    if (!user) return fail(res, 404, '성도를 찾을 수 없습니다.');
    const active = !!req.body.active;
    if (!active && user.id === req.user.id) return fail(res, 400, '자기 자신은 비활성화할 수 없습니다.');
    if (!active && user.role === 'admin' && adminCount(user.id) === 0) return fail(res, 400, '관리자는 최소 한 명 있어야 합니다.');
    db.transaction(() => {
      if (!active && user.active) {
        const teamId = currentTeamId(db, user.id);
        db.prepare('UPDATE users SET active = 0, last_team_id = ? WHERE id = ?').run(teamId, user.id);
        setTeam(db, user.id, null);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      } else if (active && !user.active) {
        db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(user.id);
        const t = user.last_team_id ? getTeam(user.last_team_id) : null;
        if (t && !t.deleted_at) setTeam(db, user.id, t.id);
      }
    })();
    res.json({ ok: true });
  });

  admin.post('/users/:id/pin', (req, res) => {
    const user = getUser(req.params.id);
    if (!user) return fail(res, 404, '성도를 찾을 수 없습니다.');
    const pin = String(req.body.pin || '');
    if (!isValidPin(pin)) return fail(res, 400, 'PIN은 숫자 4~8자리로 입력해 주세요.');
    const { hash, salt } = hashPin(pin);
    db.prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hash, salt, user.id);
    if (user.id !== req.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    res.json({ ok: true });
  });

  admin.delete('/users/:id', (req, res) => {
    const user = getUser(req.params.id);
    if (!user) return fail(res, 404, '성도를 찾을 수 없습니다.');
    if (user.id === req.user.id) return fail(res, 400, '자기 자신은 삭제할 수 없습니다.');
    if (user.role === 'admin' && adminCount(user.id) === 0) return fail(res, 400, '관리자는 최소 한 명 있어야 합니다.');
    db.transaction(() => {
      db.prepare('DELETE FROM checks WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM memberships WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    })();
    fs.rm(path.join(photoDir, String(user.id)), { recursive: true, force: true }, () => {});
    res.json({ ok: true });
  });

  // ---------- 관리자: 팀 ----------
  admin.get('/teams', (req, res) => {
    const teams = db.prepare('SELECT id, name, deleted_at, created_at FROM teams ORDER BY id').all();
    const members = db.prepare(
      `SELECT m.team_id, u.id, u.name, u.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.end_date IS NULL ORDER BY u.name COLLATE NOCASE`
    ).all();
    const byTeam = new Map();
    for (const m of members) {
      if (!byTeam.has(m.team_id)) byTeam.set(m.team_id, []);
      byTeam.get(m.team_id).push({ id: m.id, name: m.name, role: m.role });
    }
    res.json({
      teams: teams.filter((t) => !t.deleted_at).map((t) => ({ id: t.id, name: t.name, members: byTeam.get(t.id) || [] })),
      deletedTeams: teams.filter((t) => t.deleted_at).map((t) => ({ id: t.id, name: t.name, deletedAt: t.deleted_at })),
    });
  });

  function teamNameTaken(name, exceptId) {
    return !!db.prepare('SELECT id FROM teams WHERE name = ? AND deleted_at IS NULL AND id != ?').get(name, exceptId || 0);
  }

  admin.post('/teams', (req, res) => {
    const name = cleanName(req.body.name);
    if (!name) return fail(res, 400, '팀 이름을 입력해 주세요.');
    if (teamNameTaken(name)) return fail(res, 409, '같은 이름의 팀이 이미 있습니다.');
    const id = db.prepare('INSERT INTO teams (name) VALUES (?)').run(name).lastInsertRowid;
    res.json({ ok: true, id });
  });

  admin.patch('/teams/:id', (req, res) => {
    const team = getTeam(req.params.id);
    if (!team) return fail(res, 404, '팀을 찾을 수 없습니다.');
    const name = cleanName(req.body.name);
    if (!name) return fail(res, 400, '팀 이름을 입력해 주세요.');
    if (teamNameTaken(name, team.id)) return fail(res, 409, '같은 이름의 팀이 이미 있습니다.');
    db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, team.id);
    res.json({ ok: true });
  });

  admin.delete('/teams/:id', (req, res) => {
    const team = getTeam(req.params.id);
    if (!team || team.deleted_at) return fail(res, 404, '팀을 찾을 수 없습니다.');
    db.transaction(() => {
      const open = db.prepare('SELECT user_id FROM memberships WHERE team_id = ? AND end_date IS NULL').all(team.id);
      for (const m of open) setTeam(db, m.user_id, null);
      db.prepare("UPDATE teams SET deleted_at = datetime('now') WHERE id = ?").run(team.id);
    })();
    res.json({ ok: true });
  });

  admin.post('/teams/:id/restore', (req, res) => {
    const team = getTeam(req.params.id);
    if (!team || !team.deleted_at) return fail(res, 404, '팀을 찾을 수 없습니다.');
    if (teamNameTaken(team.name, team.id)) return fail(res, 409, '같은 이름의 팀이 이미 있어 복구할 수 없습니다. 기존 팀 이름을 먼저 바꿔 주세요.');
    db.prepare('UPDATE teams SET deleted_at = NULL WHERE id = ?').run(team.id);
    res.json({ ok: true });
  });

  admin.post('/teams/:id/members', (req, res) => {
    const team = getTeam(req.params.id);
    if (!team || team.deleted_at) return fail(res, 404, '팀을 찾을 수 없습니다.');
    const ids = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number).filter(Boolean) : [];
    if (!ids.length) return fail(res, 400, '추가할 성도를 선택해 주세요.');
    db.transaction(() => {
      for (const id of ids) {
        const u = getUser(id);
        if (u && u.active) setTeam(db, u.id, team.id);
      }
    })();
    res.json({ ok: true });
  });

  // ---------- 관리자: 통계 ----------
  function readPeriod(req, res) {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end)) { fail(res, 400, '기간을 올바르게 입력해 주세요.'); return null; }
    if (start > end) { fail(res, 400, '시작일이 종료일보다 늦습니다.'); return null; }
    if (addDays(start, MAX_PERIOD_DAYS) < end) { fail(res, 400, `기간은 최대 ${MAX_PERIOD_DAYS}일까지 조회할 수 있습니다.`); return null; }
    return { start, end };
  }

  admin.get('/stats', (req, res) => {
    const p = readPeriod(req, res);
    if (p) res.json(stats.overview(db, p.start, p.end));
  });

  admin.get('/stats/team/:id', (req, res) => {
    const p = readPeriod(req, res);
    if (!p) return;
    const d = stats.teamDetail(db, Number(req.params.id), p.start, p.end);
    if (!d) return fail(res, 404, '팀을 찾을 수 없습니다.');
    res.json(d);
  });

  admin.get('/stats.csv', (req, res) => {
    const p = readPeriod(req, res);
    if (!p) return;
    const csv = stats.statsCsv(db, p.start, p.end);
    const fname = `화정찬양부_통계_${p.start}_${p.end}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hwajung_stats_${p.start}_${p.end}.csv"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(csv);
  });

  // ---------- 관리자: 사진 확인 ----------
  admin.get('/photos', (req, res) => {
    const p = readPeriod(req, res);
    if (!p) return;
    const params = [p.start, p.end];
    let sql = `SELECT c.id, c.user_id, u.name AS user_name, c.date, c.item, c.updated_at, (c.thumb IS NOT NULL) AS has_thumb
               FROM checks c JOIN users u ON u.id = c.user_id WHERE c.date >= ? AND c.date <= ?`;
    if (req.query.userId) { sql += ' AND c.user_id = ?'; params.push(Number(req.query.userId)); }
    if (req.query.item && ITEMS.includes(req.query.item)) { sql += ' AND c.item = ?'; params.push(req.query.item); }
    sql += ` ORDER BY c.date DESC, u.name COLLATE NOCASE, CASE c.item WHEN 'prayer' THEN 1 WHEN 'weclick' THEN 2 ELSE 3 END LIMIT 2001`;
    const rows = db.prepare(sql).all(...params);
    res.json({ photos: rows.slice(0, 2000).map((r) => ({ ...r, has_thumb: !!r.has_thumb })), truncated: rows.length > 2000 });
  });

  app.use('/api/admin', admin);
  app.use('/api', (req, res) => fail(res, 404, '없는 주소입니다.'));

  // ---------- 화면 ----------
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    if (res.headersSent) return;
    fail(res, 500, '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  });

  app.locals.db = db;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`화정 찬양부 서버가 http://localhost:${port} 에서 실행 중입니다.`));
}

module.exports = { createApp };
