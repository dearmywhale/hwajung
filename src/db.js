'use strict';
const { kstToday, addDays } = require('./util');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    pin_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    last_team_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower ON users (lower(name));
  CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- 팀 소속 이력: start_date ~ end_date(포함), end_date 가 NULL 이면 현재 소속 (날짜는 'YYYY-MM-DD', 한국 시간)
  CREATE TABLE IF NOT EXISTS memberships (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    start_date TEXT NOT NULL,
    end_date TEXT
  );
  CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);
  CREATE INDEX IF NOT EXISTS memberships_team ON memberships(team_id);
  CREATE TABLE IF NOT EXISTS checks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    item TEXT NOT NULL CHECK (item IN ('prayer','weclick','word')),
    photo TEXT NOT NULL,
    thumb TEXT,
    mime TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, date, item)
  );
  CREATE INDEX IF NOT EXISTS checks_date ON checks(date);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at DOUBLE PRECISION NOT NULL
  );
  CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    until_ms DOUBLE PRECISION NOT NULL
  );
`;

async function migrate(db) {
  await db.exec(SCHEMA);
}

// 현재 소속 팀 변경 (teamId 가 null 이면 소속 해제). 이전 소속 이력은 그대로 남는다.
// q: 트랜잭션 안의 쿼리 함수
async function setTeam(q, userId, teamId) {
  const today = kstToday();
  const yesterday = addDays(today, -1);
  teamId = teamId == null ? null : Number(teamId);
  const [open] = await q('SELECT * FROM memberships WHERE user_id = $1 AND end_date IS NULL', [userId]);
  if (open && teamId != null && open.team_id === teamId) return;
  if (open) {
    if (open.start_date >= today) await q('DELETE FROM memberships WHERE id = $1', [open.id]);
    else await q('UPDATE memberships SET end_date = $1 WHERE id = $2', [yesterday, open.id]);
  }
  if (teamId == null) return;
  // 어제까지 같은 팀이었다면 이력을 이어 붙인다
  const [prev] = await q(
    'SELECT id FROM memberships WHERE user_id = $1 AND team_id = $2 AND end_date = $3 ORDER BY id DESC LIMIT 1',
    [userId, teamId, yesterday]
  );
  if (prev) await q('UPDATE memberships SET end_date = NULL WHERE id = $1', [prev.id]);
  else await q('INSERT INTO memberships (user_id, team_id, start_date) VALUES ($1, $2, $3)', [userId, teamId, today]);
}

async function currentTeamId(q, userId) {
  const [row] = await q('SELECT team_id FROM memberships WHERE user_id = $1 AND end_date IS NULL', [userId]);
  return row ? row.team_id : null;
}

module.exports = { migrate, setTeam, currentTeamId };
