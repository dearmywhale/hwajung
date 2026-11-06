'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/application');
const { kstToday, addDays } = require('../src/util');

// 1x1 JPEG
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

let server, base, dataDir, db;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwajung-test-'));
  const app = createApp({ dataDir });
  db = (await app.locals.ready()).db;
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  async function call(method, url, body) {
    const headers = { 'X-Requested-With': 'hwajung' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(base + url, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  }
  return { call };
}

function photoForm(date) {
  const fd = new FormData();
  fd.append('date', date);
  fd.append('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'a.jpg');
  fd.append('thumb', new Blob([JPEG], { type: 'image/jpeg' }), 't.jpg');
  return fd;
}

const today = kstToday();
const admin = client();
const kim = client();
const lee = client();
let teamA, teamB, kimId, leeId;

test('최초 관리자 설정과 로그인', async () => {
  assert.equal((await admin.call('GET', '/api/setup-status')).data.needsSetup, true);
  assert.equal((await admin.call('POST', '/api/setup', { name: '관리자', pin: '1234' })).status, 200);
  assert.equal((await client().call('POST', '/api/setup', { name: '해커', pin: '1234' })).status, 409);
  const me = await admin.call('GET', '/api/me');
  assert.equal(me.data.user.role, 'admin');
  assert.equal((await client().call('POST', '/api/login', { name: '관리자', pin: '0000' })).status, 401);
});

test('CSRF 헤더 없는 변경 요청은 거부', async () => {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('팀과 성도 만들기', async () => {
  teamA = (await admin.call('POST', '/api/admin/teams', { name: '1팀' })).data.id;
  teamB = (await admin.call('POST', '/api/admin/teams', { name: '2팀' })).data.id;
  assert.equal((await admin.call('POST', '/api/admin/teams', { name: '1팀' })).status, 409);
  kimId = (await admin.call('POST', '/api/admin/users', { name: '김성도', pin: '1111', teamId: teamA })).data.id;
  leeId = (await admin.call('POST', '/api/admin/users', { name: '이성도', pin: '22222222' })).data.id;
  assert.equal((await admin.call('POST', '/api/admin/users', { name: '김성도', pin: '1111' })).status, 409);
  assert.equal((await admin.call('POST', '/api/admin/users', { name: '박', pin: '12a4' })).status, 400);
  assert.equal((await admin.call('POST', '/api/admin/users', { name: '박', pin: '123' })).status, 400);
  // + 버튼: 여러 명 추가 (관리자 본인 포함)
  const me = (await admin.call('GET', '/api/me')).data.user;
  assert.equal((await admin.call('POST', `/api/admin/teams/${teamA}/members`, { userIds: [leeId, me.id] })).status, 200);
  const teams = (await admin.call('GET', '/api/admin/teams')).data.teams;
  assert.deepEqual(teams.find((t) => t.id === teamA).members.map((m) => m.name).sort(), ['관리자', '김성도', '이성도'].sort());
  assert.equal((await kim.call('POST', '/api/login', { name: '김성도', pin: '1111' })).status, 200);
  assert.equal((await lee.call('POST', '/api/login', { name: '이성도', pin: '22222222' })).status, 200);
});

test('일반 성도는 관리자 기능에 접근할 수 없음', async () => {
  for (const url of ['/api/admin/users', '/api/admin/teams', `/api/admin/stats?start=${today}&end=${today}`,
    `/api/admin/stats/team/${teamA}?start=${today}&end=${today}`, `/api/admin/stats.csv?start=${today}&end=${today}`,
    `/api/admin/photos?start=${today}&end=${today}`]) {
    assert.equal((await kim.call('GET', url)).status, 403, url);
  }
  assert.equal((await kim.call('POST', '/api/admin/teams', { name: 'x' })).status, 403);
});

let kimPrayerId;
test('사진 첨부로 체크, 교체, 취소', async () => {
  assert.equal((await kim.call('POST', '/api/me/checks/prayer', (() => { const f = new FormData(); f.append('date', today); return f; })())).status, 400);
  const bad = new FormData(); bad.append('date', today); bad.append('photo', new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), 'x.svg');
  assert.equal((await kim.call('POST', '/api/me/checks/prayer', bad)).status, 400);
  let r = await kim.call('POST', '/api/me/checks/prayer', photoForm(today));
  assert.equal(r.status, 200);
  kimPrayerId = r.data.checks.prayer.id;
  r = await kim.call('POST', '/api/me/checks/prayer', photoForm(today)); // 교체
  assert.equal(r.data.checks.prayer.id, kimPrayerId);
  assert.equal(fs.readdirSync(path.join(dataDir, 'photos', 'photos', String(kimId))).length, 2); // 원본+썸네일만 남음
  await kim.call('POST', '/api/me/checks/word', photoForm(today));
  r = await kim.call('DELETE', '/api/me/checks/word', { date: today });
  assert.equal(r.data.checks.word, null);
  // 지난 날짜는 수정 불가
  assert.equal((await kim.call('POST', '/api/me/checks/weclick', photoForm(addDays(today, -1)))).status, 409);
  assert.equal((await kim.call('DELETE', '/api/me/checks/prayer', { date: addDays(today, -1) })).status, 409);
  assert.equal((await kim.call('POST', '/api/me/checks/nope', photoForm(today))).status, 404);
});

test('사진은 본인과 관리자만 열람', async () => {
  assert.equal((await kim.call('GET', `/api/photos/${kimPrayerId}`)).status, 200);
  assert.equal((await admin.call('GET', `/api/photos/${kimPrayerId}?thumb=1`)).status, 200);
  assert.equal((await lee.call('GET', `/api/photos/${kimPrayerId}`)).status, 404);
  assert.equal((await client().call('GET', `/api/photos/${kimPrayerId}`)).status, 401);
});

test('달성률: 실제 소속 기간 기준, 미래 날짜 제외', async () => {
  // 과거 이력 직접 구성: 이성도는 7일 전~3일 전 2팀, 2일 전부터 1팀
  const d = (n) => addDays(today, n);
  await db.query('DELETE FROM memberships WHERE user_id = $1', [leeId]);
  await db.query('INSERT INTO memberships (user_id, team_id, start_date, end_date) VALUES ($1, $2, $3, $4)', [leeId, teamB, d(-6), d(-3)]);
  await db.query('INSERT INTO memberships (user_id, team_id, start_date) VALUES ($1, $2, $3)', [leeId, teamA, d(-2)]);
  for (const [date, item] of [[d(-6), 'prayer'], [d(-6), 'weclick'], [d(-6), 'word'], [d(-1), 'prayer'], [d(-10), 'prayer']]) {
    await db.query("INSERT INTO checks (user_id, date, item, photo, mime) VALUES ($1, $2, $3, 'file:x.jpg', 'image/jpeg')", [leeId, date, item]);
  }
  const start = d(-6);
  const end = d(3); // 미래 포함
  const r = (await admin.call('GET', `/api/admin/stats?start=${start}&end=${end}`)).data;
  assert.equal(r.effectiveEnd, today);
  assert.equal(r.days, 7);
  const b = r.teams.find((t) => t.id === teamB);
  assert.equal(b.opportunities, 4); // 이성도 4일
  assert.equal(b.done.prayer, 1);
  assert.equal(b.rates.prayer, 25);
  assert.equal(b.rates.total, 25);
  const a = r.teams.find((t) => t.id === teamA);
  // 1팀: 김성도/관리자 오늘 1일씩 + 이성도 3일 = 5
  assert.equal(a.opportunities, 5);
  assert.equal(a.done.prayer, 2); // 김 오늘 + 이 어제
  assert.equal(r.overall.opportunities, 9);
  assert.equal(r.overall.done.prayer, 3);
  assert.equal(r.overall.rates.total, Math.round((5 / 27) * 1000) / 10);

  const det = (await admin.call('GET', `/api/admin/stats/team/${teamB}?start=${start}&end=${end}`)).data;
  assert.equal(det.dates.length, 7);
  assert.equal(det.members.length, 1);
  assert.equal(det.members[0].opportunities, 4);
  assert.equal(det.daily[0].allDone, 1);
  assert.equal(det.members[0].cells[d(-2)], undefined);

  const csv = await admin.call('GET', `/api/admin/stats.csv?start=${start}&end=${end}`);
  const text = Buffer.from(csv.data).toString('utf8');
  assert.ok(text.startsWith('﻿'));
  assert.ok(text.includes('찬양부 전체'));
  assert.ok(text.includes('이성도'));
  // 미래 기간은 비어 있음
  const fut = (await admin.call('GET', `/api/admin/stats?start=${d(1)}&end=${d(5)}`)).data;
  assert.equal(fut.days, 0);
  assert.equal(fut.overall.rates.total, null);
});

test('팀 이동 시 이전 이력 유지', async () => {
  await admin.call('PUT', `/api/admin/users/${leeId}/team`, { teamId: teamB });
  const rows = await db.query('SELECT * FROM memberships WHERE user_id = $1 ORDER BY id', [leeId]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].team_id, teamA);
  assert.equal(rows[1].end_date, addDays(today, -1));
  assert.equal(rows[2].team_id, teamB);
  assert.equal(rows[2].start_date, today);
});

test('팀 삭제·복구 시 계정과 지난 통계 유지', async () => {
  const start = addDays(today, -6);
  assert.equal((await admin.call('DELETE', `/api/admin/teams/${teamB}`)).status, 200);
  const t = (await admin.call('GET', '/api/admin/teams')).data;
  assert.ok(t.deletedTeams.some((x) => x.id === teamB));
  const users = (await admin.call('GET', '/api/admin/users')).data.users;
  assert.equal(users.find((u) => u.id === leeId).team_id, null);
  const r = (await admin.call('GET', `/api/admin/stats?start=${start}&end=${today}`)).data;
  const b = r.teams.find((x) => x.id === teamB);
  assert.ok(b && b.deleted && b.opportunities === 4);
  assert.equal((await admin.call('POST', `/api/admin/teams/${teamB}/restore`)).status, 200);
  assert.ok((await admin.call('GET', '/api/admin/teams')).data.teams.some((x) => x.id === teamB));
});

test('비활성화, PIN 재설정', async () => {
  await admin.call('POST', `/api/admin/users/${kimId}/active`, { active: false });
  assert.equal((await kim.call('GET', '/api/me')).status, 401);
  assert.equal((await client().call('POST', '/api/login', { name: '김성도', pin: '1111' })).status, 403);
  await admin.call('POST', `/api/admin/users/${kimId}/active`, { active: true });
  const users = (await admin.call('GET', '/api/admin/users')).data.users;
  assert.equal(users.find((u) => u.id === kimId).team_id, teamA);
  await admin.call('POST', `/api/admin/users/${kimId}/pin`, { pin: '5555' });
  assert.equal((await kim.call('POST', '/api/login', { name: '김성도', pin: '5555' })).status, 200);
});

test('관리자 사진 목록', async () => {
  const r = (await admin.call('GET', `/api/admin/photos?start=${addDays(today, -6)}&end=${today}&userId=${kimId}`)).data;
  assert.equal(r.photos.length, 1);
  assert.equal(r.photos[0].item, 'prayer');
});

test('성도 삭제 시 계정·기록·사진 영구 삭제', async () => {
  const me = (await admin.call('GET', '/api/me')).data.user;
  assert.equal((await admin.call('DELETE', `/api/admin/users/${me.id}`)).status, 400);
  assert.equal((await admin.call('DELETE', `/api/admin/users/${kimId}`)).status, 200);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM checks WHERE user_id = $1', [kimId]))[0].n, 0);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM users WHERE id = $1', [kimId]))[0].n, 0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'photos', 'photos', String(kimId))), []);
  assert.equal((await admin.call('GET', `/api/photos/${kimPrayerId}`)).status, 404);
});
