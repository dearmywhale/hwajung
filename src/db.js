'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { kstToday, addDays } = require('./util');

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'photos'), { recursive: true });
  const db = new Database(path.join(dataDir, 'hwajung.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pin_hash TEXT NOT NULL,
      pin_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
      active INTEGER NOT NULL DEFAULT 1,
      last_team_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- 팀 소속 이력: start_date ~ end_date(포함), end_date 가 NULL 이면 현재 소속
    CREATE TABLE IF NOT EXISTS memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      start_date TEXT NOT NULL,
      end_date TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id);
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      item TEXT NOT NULL CHECK (item IN ('prayer','weclick','word')),
      photo TEXT NOT NULL,
      thumb TEXT,
      mime TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, date, item)
    );
    CREATE INDEX IF NOT EXISTS idx_checks_date ON checks(date);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

// 현재 소속 팀 변경 (teamId 가 null 이면 소속 해제). 이전 소속 이력은 그대로 남는다.
function setTeam(db, userId, teamId) {
  const today = kstToday();
  const yesterday = addDays(today, -1);
  const open = db.prepare('SELECT * FROM memberships WHERE user_id = ? AND end_date IS NULL').get(userId);
  if (open && teamId != null && open.team_id === Number(teamId)) return;
  if (open) {
    if (open.start_date >= today) {
      db.prepare('DELETE FROM memberships WHERE id = ?').run(open.id);
    } else {
      db.prepare('UPDATE memberships SET end_date = ? WHERE id = ?').run(yesterday, open.id);
    }
  }
  if (teamId == null) return;
  // 어제까지 같은 팀이었다면 이력을 이어 붙인다
  const prev = db.prepare(
    'SELECT * FROM memberships WHERE user_id = ? AND team_id = ? AND end_date = ? ORDER BY id DESC LIMIT 1'
  ).get(userId, teamId, yesterday);
  if (prev) {
    db.prepare('UPDATE memberships SET end_date = NULL WHERE id = ?').run(prev.id);
  } else {
    db.prepare('INSERT INTO memberships (user_id, team_id, start_date) VALUES (?, ?, ?)').run(userId, teamId, today);
  }
}

function currentTeamId(db, userId) {
  const row = db.prepare('SELECT team_id FROM memberships WHERE user_id = ? AND end_date IS NULL').get(userId);
  return row ? row.team_id : null;
}

module.exports = { openDb, setTeam, currentTeamId };
