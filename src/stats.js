'use strict';
const { ITEMS, ITEM_LABELS, kstToday, dateRange, minDate, maxDate } = require('./util');

function rate(done, opp) {
  return opp > 0 ? Math.round((done / opp) * 1000) / 10 : null;
}

function emptyAgg() {
  return { opportunities: 0, done: { prayer: 0, weclick: 0, word: 0 } };
}

function finishAgg(a) {
  const totalDone = ITEMS.reduce((s, i) => s + a.done[i], 0);
  return {
    opportunities: a.opportunities,
    done: a.done,
    totalDone,
    rates: {
      prayer: rate(a.done.prayer, a.opportunities),
      weclick: rate(a.done.weclick, a.opportunities),
      word: rate(a.done.word, a.opportunities),
      total: rate(totalDone, a.opportunities * ITEMS.length),
    },
  };
}

// 기간의 실제 계산 범위 (미래 날짜 제외)
function effectiveRange(start, end) {
  const today = kstToday();
  const effEnd = minDate(end, today);
  return { start, end, effEnd, today, dates: dateRange(start, effEnd) };
}

async function loadPeriod(db, start, effEnd, teamId) {
  const params = [effEnd, start];
  let sql = `SELECT m.*, u.name AS user_name, t.name AS team_name, t.deleted_at AS team_deleted
             FROM memberships m JOIN users u ON u.id = m.user_id JOIN teams t ON t.id = m.team_id
             WHERE m.start_date <= $1 AND (m.end_date IS NULL OR m.end_date >= $2)`;
  if (teamId != null) { sql += ' AND m.team_id = $3'; params.push(teamId); }
  sql += ' ORDER BY m.id';
  const memberships = start <= effEnd ? await db.query(sql, params) : [];
  const checks = start <= effEnd
    ? await db.query('SELECT id, user_id, date, item FROM checks WHERE date >= $1 AND date <= $2', [start, effEnd])
    : [];
  const checkMap = new Map(); // `${user}|${date}` -> {item: id}
  for (const c of checks) {
    const k = c.user_id + '|' + c.date;
    if (!checkMap.has(k)) checkMap.set(k, {});
    checkMap.get(k)[c.item] = c.id;
  }
  return { memberships, checkMap };
}

function membershipDays(m, start, effEnd) {
  return dateRange(maxDate(m.start_date, start), minDate(m.end_date || effEnd, effEnd));
}

async function overview(db, start, end) {
  const r = effectiveRange(start, end);
  const { memberships, checkMap } = await loadPeriod(db, start, r.effEnd, null);
  const teams = new Map();
  for (const t of await db.query('SELECT id, name, deleted_at FROM teams WHERE deleted_at IS NULL ORDER BY id')) {
    teams.set(t.id, { id: t.id, name: t.name, deleted: false, agg: emptyAgg(), members: new Set() });
  }
  const all = emptyAgg();
  const allMembers = new Set();
  for (const m of memberships) {
    if (!teams.has(m.team_id)) {
      teams.set(m.team_id, { id: m.team_id, name: m.team_name, deleted: !!m.team_deleted, agg: emptyAgg(), members: new Set() });
    }
    const t = teams.get(m.team_id);
    for (const d of membershipDays(m, start, r.effEnd)) {
      t.agg.opportunities++; all.opportunities++;
      t.members.add(m.user_id); allMembers.add(m.user_id);
      const c = checkMap.get(m.user_id + '|' + d);
      if (c) for (const i of ITEMS) if (c[i]) { t.agg.done[i]++; all.done[i]++; }
    }
  }
  return {
    start, end, effectiveEnd: r.effEnd, today: r.today, days: r.dates.length,
    overall: { memberCount: allMembers.size, ...finishAgg(all) },
    teams: [...teams.values()].map((t) => ({
      id: t.id, name: t.name, deleted: t.deleted, memberCount: t.members.size, ...finishAgg(t.agg),
    })),
  };
}

async function teamDetail(db, teamId, start, end) {
  const [team] = await db.query('SELECT id, name, deleted_at FROM teams WHERE id = $1', [teamId]);
  if (!team) return null;
  const r = effectiveRange(start, end);
  const { memberships, checkMap } = await loadPeriod(db, start, r.effEnd, teamId);
  const daily = new Map(r.dates.map((d) => [d, { date: d, members: 0, done: { prayer: 0, weclick: 0, word: 0 }, allDone: 0 }]));
  const members = new Map();
  const teamAgg = emptyAgg();
  for (const m of memberships) {
    if (!members.has(m.user_id)) members.set(m.user_id, { userId: m.user_id, name: m.user_name, agg: emptyAgg(), cells: {} });
    const mem = members.get(m.user_id);
    for (const d of membershipDays(m, start, r.effEnd)) {
      if (mem.cells[d]) continue;
      const c = checkMap.get(m.user_id + '|' + d) || {};
      mem.cells[d] = { prayer: c.prayer || null, weclick: c.weclick || null, word: c.word || null };
      const day = daily.get(d);
      day.members++; mem.agg.opportunities++; teamAgg.opportunities++;
      let n = 0;
      for (const i of ITEMS) if (c[i]) { day.done[i]++; mem.agg.done[i]++; teamAgg.done[i]++; n++; }
      if (n === ITEMS.length) day.allDone++;
    }
  }
  return {
    team: { id: team.id, name: team.name, deleted: !!team.deleted_at },
    start, end, effectiveEnd: r.effEnd, today: r.today, dates: r.dates,
    summary: { memberCount: members.size, ...finishAgg(teamAgg) },
    daily: [...daily.values()],
    members: [...members.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      .map((m) => ({ userId: m.userId, name: m.name, cells: m.cells, ...finishAgg(m.agg) })),
  };
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-./.test(s)) s = "'" + s; // 수식 삽입 방지
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function pct(v) { return v == null ? '-' : v + '%'; }

async function statsCsv(db, start, end) {
  const ov = await overview(db, start, end);
  const rows = [];
  rows.push(['화정 찬양부 통계', `${start} ~ ${end}`, `집계 ${ov.days}일 (미래 날짜 제외)`]);
  rows.push([]);
  rows.push(['[팀별 달성률]']);
  rows.push(['팀', '인원', '체크 기회(인·일)', '기도 완료', '위클릭 완료', '3분말씀 완료',
    '기도 달성률', '위클릭 달성률', '3분말씀 달성률', '전체 달성률']);
  const line = (name, t) => [name, t.memberCount, t.opportunities, t.done.prayer, t.done.weclick, t.done.word,
    pct(t.rates.prayer), pct(t.rates.weclick), pct(t.rates.word), pct(t.rates.total)];
  for (const t of ov.teams) rows.push(line(t.name + (t.deleted ? ' (삭제된 팀)' : ''), t));
  rows.push(line('찬양부 전체', ov.overall));
  rows.push([]);

  const details = [];
  for (const t of ov.teams) details.push({ t, d: await teamDetail(db, t.id, start, end) });
  rows.push(['[성도별 달성률]']);
  rows.push(['팀', '성도', '체크 기회(일)', '기도', '위클릭', '3분말씀', '기도 달성률', '위클릭 달성률', '3분말씀 달성률', '전체 달성률']);
  for (const { t, d } of details) {
    for (const m of d.members) {
      rows.push([t.name, m.name, m.opportunities, m.done.prayer, m.done.weclick, m.done.word,
        pct(m.rates.prayer), pct(m.rates.weclick), pct(m.rates.word), pct(m.rates.total)]);
    }
  }
  rows.push([]);
  rows.push(['[날짜별 체크]']);
  rows.push(['날짜', '팀', '성도', ITEM_LABELS.prayer, ITEM_LABELS.weclick, ITEM_LABELS.word, '완료 항목 수']);
  for (const date of ov.days ? dateRange(start, ov.effectiveEnd) : []) {
    for (const { t, d } of details) {
      for (const m of d.members) {
        const c = m.cells[date];
        if (!c) continue;
        const n = ITEMS.filter((i) => c[i]).length;
        rows.push([date, t.name, m.name, c.prayer ? 'O' : 'X', c.weclick ? 'O' : 'X', c.word ? 'O' : 'X', n]);
      }
    }
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { overview, teamDetail, statsCsv };
