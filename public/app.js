'use strict';
/* 화정 찬양부 — 하늘 습관으로 무장하자 */
(function () {
  const ITEMS = ['prayer', 'weclick', 'word'];
  const LABEL = { prayer: '기도', weclick: '위클릭', word: '3분말씀' };
  const SHORT = { prayer: '기', weclick: '위', word: '말' };
  const ICON = { prayer: '🙏', weclick: '👆', word: '📖' };
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  const state = {
    me: null,
    today: null,
    stats: { mode: 'week', weekStart: null, start: null, end: null },
  };

  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal-root');
  const $toast = document.getElementById('toast-root');

  // ---------- 공통 도구 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

  async function api(method, url, body) {
    const opts = { method, headers: { 'X-Requested-With': 'hwajung' }, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch(url, opts); } catch (e) { throw new ApiError('인터넷 연결을 확인해 주세요.', 0); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 빈 응답 */ }
    if (!res.ok) {
      if (res.status === 401 && state.me) { state.me = null; renderLogin(); }
      throw new ApiError((data && data.error) || '요청을 처리하지 못했습니다.', res.status);
    }
    return data;
  }

  function toast(msg, isErr) {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    $toast.appendChild(el);
    setTimeout(() => el.remove(), isErr ? 4200 : 2600);
  }
  const toastErr = (e) => toast(e && e.message ? e.message : String(e), true);

  // 날짜 (한국 시간 기준)
  function kstToday() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
  function addDays(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  function dow(d) { return new Date(d + 'T00:00:00Z').getUTCDay(); }
  function mondayOf(d) { const w = dow(d); return addDays(d, w === 0 ? -6 : 1 - w); }
  function fmtDate(d, withYear) {
    const [y, m, dd] = d.split('-').map(Number);
    return (withYear ? `${y}년 ` : '') + `${m}월 ${dd}일 (${DOW[dow(d)]})`;
  }
  function fmtShort(d) { const [, m, dd] = d.split('-').map(Number); return `${m}/${dd}`; }
  function fmtRange(a, b) {
    const [ya, ma, da] = a.split('-').map(Number); const [yb, mb, db] = b.split('-').map(Number);
    return ya === yb ? `${ya}.${ma}.${da} – ${mb}.${db}` : `${ya}.${ma}.${da} – ${yb}.${mb}.${db}`;
  }
  function diffDays(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
  const pct = (v) => (v == null ? '–' : `${v}%`);

  function photoUrl(id, thumb) { return `/api/photos/${id}${thumb ? '?thumb=1' : ''}`; }

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    const parts = (path || '').split('/').filter(Boolean);
    const q = Object.fromEntries(new URLSearchParams(qs || ''));
    return { parts, q };
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  // ---------- 모달 ----------
  function openModal(html, { wide, onClose } = {}) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    $modal.appendChild(back);
    back.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    const first = back.querySelector('input:not([type=checkbox]), select');
    if (first && window.matchMedia('(min-width: 700px)').matches) setTimeout(() => first.focus(), 30);
    return { el: back.querySelector('.modal'), close };
  }

  function confirmDialog({ title, message, ok = '확인', danger }) {
    return new Promise((resolve) => {
      let done = false;
      const m = openModal(`
        <h2>${esc(title)}</h2>
        <p>${message}</p>
        <div class="actions">
          <button class="btn" data-close>취소</button>
          <button class="btn ${danger ? 'danger solid' : 'primary'}" data-ok>${esc(ok)}</button>
        </div>`, { onClose: () => { if (!done) resolve(false); } });
      m.el.querySelector('[data-ok]').addEventListener('click', () => { done = true; m.close(); resolve(true); });
    });
  }

  // 폼 모달: fields 배열, onSubmit(values) 가 throw 하면 에러 표시
  function formModal({ title, fields, submit = '저장', onSubmit, extra = '' }) {
    const m = openModal(`
      <h2>${esc(title)}</h2>
      <form novalidate>
        ${fields.map((f) => fieldHtml(f)).join('')}
        ${extra}
        <div class="error-text" data-err></div>
        <div class="actions">
          <button type="button" class="btn" data-close>취소</button>
          <button type="submit" class="btn primary">${esc(submit)}</button>
        </div>
      </form>`);
    const form = m.el.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try { await onSubmit(values, m); m.close(); } catch (err) { form.querySelector('[data-err]').textContent = err.message; } finally { btn.disabled = false; }
    });
    return m;
  }

  function fieldHtml(f) {
    const id = 'f_' + f.name + '_' + Math.random().toString(36).slice(2, 7);
    if (f.type === 'select') {
      return `<div class="field"><label for="${id}">${esc(f.label)}</label>
        <select class="input" id="${id}" name="${f.name}">${f.options.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(f.value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`;
    }
    const pin = f.type === 'pin';
    return `<div class="field"><label for="${id}">${esc(f.label)}</label>
      <input class="input" id="${id}" name="${f.name}" value="${esc(f.value || '')}" autocomplete="off"
        ${pin ? 'type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="숫자 4~8자리"' : `type="text" maxlength="40"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}`}></div>`;
  }

  function checkPin(pin) { if (!/^\d{4,8}$/.test(pin || '')) throw new Error('PIN은 숫자 4~8자리로 입력해 주세요.'); }

  // ---------- 사진 확대 보기 ----------
  function openLightbox(list, index) {
    // list: [{id, caption}]
    let i = index;
    const el = document.createElement('div');
    el.className = 'lightbox';
    el.innerHTML = `
      <div class="lb-top"><div class="lb-cap"></div><button class="lb-btn" data-x aria-label="닫기">✕</button></div>
      <div class="lb-stage">
        <img alt="">
        <button class="lb-btn lb-prev" aria-label="이전">‹</button>
        <button class="lb-btn lb-next" aria-label="다음">›</button>
      </div>`;
    const img = el.querySelector('img');
    const cap = el.querySelector('.lb-cap');
    const prev = el.querySelector('.lb-prev');
    const next = el.querySelector('.lb-next');
    function show() {
      const p = list[i];
      img.src = photoUrl(p.id);
      cap.textContent = (p.caption || '') + (list.length > 1 ? `  ·  ${i + 1}/${list.length}` : '');
      prev.style.display = i > 0 ? '' : 'none';
      next.style.display = i < list.length - 1 ? '' : 'none';
    }
    const close = () => { el.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft' && i > 0) { i--; show(); }
      else if (e.key === 'ArrowRight' && i < list.length - 1) { i++; show(); }
    };
    prev.addEventListener('click', (e) => { e.stopPropagation(); if (i > 0) { i--; show(); } });
    next.addEventListener('click', (e) => { e.stopPropagation(); if (i < list.length - 1) { i++; show(); } });
    el.querySelector('[data-x]').addEventListener('click', close);
    el.querySelector('.lb-stage').addEventListener('click', (e) => { if (e.target.classList.contains('lb-stage')) close(); });
    img.addEventListener('error', () => { cap.textContent = '사진을 불러오지 못했습니다.'; });
    // 좌우로 밀어서 넘기기
    let sx = null;
    el.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx; sx = null;
      if (dx > 50 && i > 0) { i--; show(); } else if (dx < -50 && i < list.length - 1) { i++; show(); }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(el);
    show();
  }

  // ---------- 이미지 축소 ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('미리보기를 표시할 수 없는 형식입니다.')); };
      img.src = url;
    });
  }
  function toJpeg(img, max, quality) {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', quality));
  }
  async function preparePhoto(file) {
    if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) throw new Error('사진 파일만 첨부할 수 있습니다.');
    try {
      const { img, url } = await loadImage(file);
      const photo = (await toJpeg(img, 1600, 0.85)) || file;
      const thumb = await toJpeg(img, 480, 0.8);
      return { photo, thumb, previewUrl: url };
    } catch (e) {
      if (file.size > 15 * 1024 * 1024) throw new Error('사진 용량이 너무 큽니다 (최대 15MB).');
      return { photo: file, thumb: null, previewUrl: null };
    }
  }

  // ---------- 로그인 ----------
  const BRAND_SVG = '<img class="brand-mark" src="/icon.svg" alt="">';

  async function boot() {
    try {
      const data = await api('GET', '/api/me');
      state.me = data.user;
      renderShell();
    } catch (e) {
      if (e.status === 401) {
        let needsSetup = false;
        try { needsSetup = (await api('GET', '/api/setup-status')).needsSetup; } catch (e2) { /* 무시 */ }
        needsSetup ? renderSetup() : renderLogin();
      } else {
        $app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><p class="empty">${esc(e.message)}</p><button class="btn block" onclick="location.reload()">다시 시도</button></div></div>`;
      }
    }
  }

  function authCard(inner) {
    return `<div class="auth-wrap"><div class="auth-card">${BRAND_SVG}
      <h1 class="auth-title">화정 찬양부</h1><p class="auth-sub">하늘 습관으로 무장하자</p>${inner}</div></div>`;
  }

  function renderLogin() {
    document.title = '화정 찬양부';
    $app.innerHTML = authCard(`
      <form id="login" novalidate>
        <div class="field"><label for="ln">이름</label><input class="input" id="ln" name="name" autocomplete="username" maxlength="40" required></div>
        <div class="field"><label for="lp">PIN</label><input class="input" id="lp" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="current-password" placeholder="숫자 4~8자리" required></div>
        <div class="error-text" id="lerr"></div>
        <button class="btn primary block" type="submit">로그인</button>
      </form>
      <p class="auth-note">계정이 없으면 찬양부 관리자에게 요청해 주세요.</p>`);
    const form = document.getElementById('login');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      const err = document.getElementById('lerr');
      err.textContent = '';
      if (!v.name.trim()) { err.textContent = '이름을 입력해 주세요.'; return; }
      if (!/^\d{4,8}$/.test(v.pin)) { err.textContent = 'PIN은 숫자 4~8자리입니다.'; return; }
      const btn = form.querySelector('button'); btn.disabled = true;
      try { await api('POST', '/api/login', v); location.hash = '#/today'; await boot(); } catch (x) { err.textContent = x.message; } finally { btn.disabled = false; }
    });
  }

  function renderSetup() {
    $app.innerHTML = authCard(`
      <div class="notice">처음 사용하시네요. 찬양부 관리자 계정을 만들어 주세요.</div>
      <form id="setup" novalidate>
        <div class="field"><label for="sn">관리자 이름</label><input class="input" id="sn" name="name" maxlength="40" required></div>
        <div class="field"><label for="sp">PIN</label><input class="input" id="sp" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="숫자 4~8자리" required></div>
        <div class="field"><label for="sp2">PIN 확인</label><input class="input" id="sp2" name="pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" required></div>
        <div class="error-text" id="serr"></div>
        <button class="btn primary block" type="submit">관리자 계정 만들기</button>
      </form>`);
    const form = document.getElementById('setup');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      const err = document.getElementById('serr');
      try {
        if (!v.name.trim()) throw new Error('이름을 입력해 주세요.');
        checkPin(v.pin);
        if (v.pin !== v.pin2) throw new Error('PIN이 서로 다릅니다.');
        await api('POST', '/api/setup', { name: v.name, pin: v.pin });
        location.hash = '#/teams';
        await boot();
      } catch (x) { err.textContent = x.message; }
    });
  }

  // ---------- 화면 틀 ----------
  const NAV_ICONS = {
    today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    members: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/></svg>',
    teams: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    photos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="4"/></svg>',
  };

  function renderShell() {
    const isAdmin = state.me.role === 'admin';
    const link = (key, label) => `<a href="#/${key}" data-nav="${key}">${NAV_ICONS[key]}<span>${label}</span></a>`;
    $app.innerHTML = `
      <div class="layout" id="layout">
        <aside class="sidebar" id="sidebar">
          <div class="side-brand"><img src="/icon.svg" alt=""><div><div class="t">화정 찬양부</div><div class="s">하늘 습관으로 무장하자</div></div></div>
          <div class="side-user"><b>${esc(state.me.name)}</b> 님${isAdmin ? ' · 관리자' : ''}<br>${state.me.team ? esc(state.me.team.name) : '소속 팀 없음'}</div>
          <nav class="nav">
            ${link('today', '천국 한걸음')}
            ${link('history', '내 기록')}
            ${isAdmin ? `<div class="nav-label">관리</div>${link('stats', '통계')}${link('members', '성도 관리')}${link('teams', '팀 관리')}${link('photos', '사진 확인')}` : ''}
            <div class="nav-label">설정</div>
            ${link('account', 'PIN 변경')}
          </nav>
          <div class="side-foot"><button class="btn" id="logout">로그아웃</button></div>
        </aside>
        <div class="backdrop" id="backdrop"></div>
        <div class="main">
          <header class="topbar">
            <button class="btn icon ghost" id="menu" aria-label="메뉴 열기"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
            <span class="t">화정 찬양부</span>
          </header>
          <main class="content" id="view"></main>
        </div>
      </div>`;
    const layout = document.getElementById('layout');
    document.getElementById('menu').addEventListener('click', () => layout.classList.add('nav-open'));
    document.getElementById('backdrop').addEventListener('click', () => layout.classList.remove('nav-open'));
    document.getElementById('sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) layout.classList.remove('nav-open'); });
    document.getElementById('logout').addEventListener('click', async () => {
      try { await api('POST', '/api/logout'); } catch (e) { /* 무시 */ }
      state.me = null; location.hash = ''; renderLogin();
    });
    route();
  }

  async function refreshMe() {
    try {
      const data = await api('GET', '/api/me');
      state.me = data.user;
      const box = document.querySelector('.side-user');
      if (box) box.innerHTML = `<b>${esc(state.me.name)}</b> 님${state.me.role === 'admin' ? ' · 관리자' : ''}<br>${state.me.team ? esc(state.me.team.name) : '소속 팀 없음'}`;
    } catch (e) { /* 무시 */ }
  }

  let routeToken = 0;
  function route() {
    if (!state.me) return;
    const { parts, q } = parseHash();
    const isAdmin = state.me.role === 'admin';
    let page = parts[0] || 'today';
    const adminPages = ['stats', 'members', 'teams', 'photos'];
    if (adminPages.includes(page) && !isAdmin) page = 'today';
    if (!['today', 'history', 'account', ...adminPages].includes(page)) page = 'today';
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
    const old = document.getElementById('view');
    if (!old) return;
    // 이전 화면의 이벤트 핸들러가 남지 않도록 새 요소로 교체
    const view = old.cloneNode(false);
    old.replaceWith(view);
    const token = ++routeToken;
    view.innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto"></div></div>';
    const ctx = { view, q, parts, alive: () => token === routeToken };
    window.scrollTo(0, 0);
    const pages = { today: pageToday, history: pageHistory, account: pageAccount, stats: parts[1] === 'team' ? pageTeamDetail : pageStats, members: pageMembers, teams: pageTeams, photos: pagePhotos };
    Promise.resolve(pages[page](ctx)).catch((e) => { if (ctx.alive()) view.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; });
  }

  // ---------- 천국 한걸음 ----------
  async function pageToday(ctx) {
    document.title = '천국 한걸음 · 화정 찬양부';
    const data = await api('GET', '/api/me/today');
    if (!ctx.alive()) return;
    const local = {}; // item -> {photo, thumb, previewUrl, uploading}
    let date = data.date;
    let checks = data.checks;

    function render() {
      const n = ITEMS.filter((i) => checks[i]).length;
      const msg = n === 3 ? '오늘의 하늘 습관을 모두 지켰어요!' : n === 0 ? '오늘도 한 걸음씩 시작해요.' : `${3 - n}개 남았어요. 조금만 더 힘내요!`;
      const C = 2 * Math.PI * 32;
      ctx.view.innerHTML = `
        <section class="today-hero">
          <div>
            <div class="date">${esc(fmtDate(date, true))}</div>
            <h1>천국 한걸음</h1>
            <div class="msg">${esc(msg)}</div>
          </div>
          <div class="ring" aria-label="오늘 ${n}개 완료">
            <svg viewBox="0 0 76 76"><circle cx="38" cy="38" r="32" stroke="rgba(255,255,255,.2)" stroke-width="7" fill="none"/>
            <circle cx="38" cy="38" r="32" stroke="#e2c98a" stroke-width="7" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - n / 3)}"/></svg>
            <div class="num">${n}/3</div>
          </div>
        </section>
        ${state.me.team ? '' : '<div class="notice">아직 소속 팀이 없어요. 체크는 할 수 있지만, 팀 배정은 관리자에게 요청해 주세요.</div>'}
        <div class="check-grid">${ITEMS.map(cardHtml).join('')}</div>
        <input type="file" accept="image/*" id="file-input" hidden>`;
      bind();
    }

    function cardHtml(item) {
      const c = checks[item];
      const l = local[item];
      let box, actions, stateText;
      if (l && l.uploading) {
        box = `<div class="photo-box filled">${l.previewUrl ? `<img src="${l.previewUrl}" alt="" style="opacity:.5">` : ''}<div style="position:absolute;inset:0;display:grid;place-items:center"><div class="spinner"></div></div></div>`;
        actions = '<button class="btn block" disabled>저장 중…</button>';
        stateText = '사진을 올리는 중이에요';
      } else if (l) {
        box = `<div class="photo-box filled" data-preview="${item}">${l.previewUrl ? `<img src="${l.previewUrl}" alt="선택한 사진">` : '<div class="ph"><span class="big">🖼️</span>미리보기를 지원하지 않는 형식이에요.<br>그대로 올릴 수 있어요.</div>'}<span class="tag">미리보기</span></div>`;
        actions = `<button class="btn primary" data-submit="${item}">체크 완료</button><button class="btn" data-pick="${item}">다시 선택</button><button class="btn ghost" data-discard="${item}">취소</button>`;
        stateText = '사진을 확인하고 체크 완료를 눌러 주세요';
      } else if (c) {
        box = `<div class="photo-box filled" data-view="${item}"><img src="${photoUrl(c.id, true)}&v=${encodeURIComponent(c.updatedAt)}" alt="${LABEL[item]} 인증 사진" loading="lazy"><span class="tag">✓ 완료</span></div>`;
        actions = `<button class="btn soft" data-pick="${item}">사진 교체</button><button class="btn danger" data-cancel="${item}">체크 취소</button>`;
        stateText = '완료했어요';
      } else {
        box = `<button type="button" class="photo-box" data-pick="${item}" style="cursor:pointer;width:100%"><div class="ph"><span class="big">📷</span>사진을 첨부하면<br>체크가 완료돼요</div></button>`;
        actions = `<button class="btn primary block" data-pick="${item}">사진 첨부</button>`;
        stateText = '아직 하지 않았어요';
      }
      return `<article class="card check-card${c && !l ? ' done' : ''}">
        <div class="check-head"><div class="check-icon">${c && !l ? '✓' : ICON[item]}</div><div><div class="check-name">${LABEL[item]}</div><div class="check-state">${stateText}</div></div></div>
        ${box}
        <div class="check-actions">${actions}</div>
      </article>`;
    }

    let pickingItem = null;
    function bind() {
      const input = document.getElementById('file-input');
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file || !pickingItem) return;
        const item = pickingItem;
        try {
          const prepared = await preparePhoto(file);
          if (local[item] && local[item].previewUrl) URL.revokeObjectURL(local[item].previewUrl);
          local[item] = prepared;
          render();
        } catch (e) { toastErr(e); }
      });
      ctx.view.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
        if (kstToday() !== date) { reloadForNewDay(); return; }
        pickingItem = b.dataset.pick; input.click();
      }));
      ctx.view.querySelectorAll('[data-discard]').forEach((b) => b.addEventListener('click', () => {
        const it = b.dataset.discard;
        if (local[it] && local[it].previewUrl) URL.revokeObjectURL(local[it].previewUrl);
        delete local[it]; render();
      }));
      ctx.view.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
        const it = b.dataset.view;
        openLightbox([{ id: checks[it].id, caption: `${LABEL[it]} · ${fmtDate(date)}` }], 0);
      }));
      ctx.view.querySelectorAll('[data-submit]').forEach((b) => b.addEventListener('click', () => submit(b.dataset.submit)));
      ctx.view.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => cancel(b.dataset.cancel)));
    }

    async function submit(item) {
      const l = local[item];
      if (!l) return;
      l.uploading = true; render();
      const fd = new FormData();
      fd.append('date', date);
      fd.append('photo', l.photo, 'photo.jpg');
      if (l.thumb) fd.append('thumb', l.thumb, 'thumb.jpg');
      try {
        const res = await api('POST', `/api/me/checks/${item}`, fd);
        checks = res.checks;
        if (l.previewUrl) URL.revokeObjectURL(l.previewUrl);
        delete local[item];
        toast(`${LABEL[item]} 체크 완료!`);
      } catch (e) {
        l.uploading = false;
        toastErr(e);
        if (e.status === 409) { reloadForNewDay(); return; }
      }
      if (ctx.alive()) render();
    }

    async function cancel(item) {
      const ok = await confirmDialog({ title: `${LABEL[item]} 체크 취소`, message: '체크를 취소하면 올린 사진도 함께 지워져요. 취소할까요?', ok: '체크 취소', danger: true });
      if (!ok) return;
      try {
        const res = await api('DELETE', `/api/me/checks/${item}`, { date });
        checks = res.checks;
        toast('체크를 취소했어요.');
        render();
      } catch (e) { toastErr(e); if (e.status === 409) reloadForNewDay(); }
    }

    function reloadForNewDay() {
      toast('날짜가 바뀌어 오늘 화면을 새로 불러왔어요.');
      route();
    }

    // 자정이 지나면 자동으로 새 날짜로 전환
    const timer = setInterval(() => {
      if (!ctx.alive()) { clearInterval(timer); return; }
      if (kstToday() !== date && !Object.values(local).some((l) => l.uploading)) { clearInterval(timer); reloadForNewDay(); }
    }, 30000);

    render();
  }

  // ---------- 내 기록 ----------
  async function pageHistory(ctx) {
    document.title = '내 기록 · 화정 찬양부';
    const today = kstToday();
    const month = /^\d{4}-\d{2}$/.test(ctx.q.month || '') ? ctx.q.month : today.slice(0, 7);
    const data = await api('GET', `/api/me/history?month=${month}`);
    if (!ctx.alive()) return;
    const byDate = {};
    for (const c of data.checks) (byDate[c.date] = byDate[c.date] || {})[c.item] = c.id;
    const first = month + '-01';
    const nextMonth = addDays(first, 32).slice(0, 7);
    const last = addDays(nextMonth + '-01', -1);
    const prevMonth = addDays(first, -1).slice(0, 7);
    const pastEnd = last < today ? last : today;
    const daysPast = first <= today ? diffDays(first, pastEnd) + 1 : 0;
    const totalChecks = data.checks.length;
    const fullDays = Object.values(byDate).filter((d) => ITEMS.every((i) => d[i])).length;
    const counts = Object.fromEntries(ITEMS.map((i) => [i, data.checks.filter((c) => c.item === i).length]));
    const [y, m] = month.split('-').map(Number);
    let sel = ctx.q.date && ctx.q.date.startsWith(month) && ctx.q.date <= today ? ctx.q.date : (month === today.slice(0, 7) ? today : null);

    function cal() {
      const cells = [];
      for (let k = 0; k < dow(first); k++) cells.push('<div class="day out"></div>');
      for (let d = first; d <= last; d = addDays(d, 1)) {
        const c = byDate[d] || {};
        const n = ITEMS.filter((i) => c[i]).length;
        const fut = d > today;
        cells.push(`<button type="button" class="day${fut ? ' future' : ''}${d === today ? ' today' : ''}${d === sel ? ' sel' : ''}${n === 3 ? ' full' : ''}" ${fut ? 'disabled' : `data-d="${d}"`}>
          <span class="n">${Number(d.slice(8))}</span>${fut ? '' : `<span class="dots">${ITEMS.map((i) => `<i class="${c[i] ? 'on' : ''}"></i>`).join('')}</span>`}</button>`);
      }
      return cells.join('');
    }

    function detail() {
      if (!sel) return '<p class="muted small">날짜를 누르면 그날의 체크와 사진을 볼 수 있어요.</p>';
      const c = byDate[sel] || {};
      return `<h3 class="card-title">${esc(fmtDate(sel))}${sel === today ? ' <span class="badge green">오늘</span>' : ''}</h3>
        <div class="day-detail">${ITEMS.map((i) => `<div class="mini-photo">${c[i] ? `<img src="${photoUrl(c[i], true)}" alt="${LABEL[i]}" data-ph="${i}" loading="lazy">` : `<span>${ICON[i]}<br>미체크</span>`}<span class="tag">${LABEL[i]}</span></div>`).join('')}</div>
        ${sel === today ? '<div class="row" style="margin-top:12px"><a class="btn soft sm" href="#/today">오늘 체크하러 가기</a></div>' : '<p class="muted small" style="margin:10px 0 0">지난 날짜의 체크와 사진은 수정할 수 없어요.</p>'}`;
    }

    function render() {
      ctx.view.innerHTML = `
        <div class="page-head"><div><h1 class="page-title">내 기록</h1><p class="page-sub">나의 하늘 습관 발자취</p></div></div>
        <div class="summary-tiles">
          <div class="tile"><div class="k">${m}월 모두 완료한 날</div><div class="v">${fullDays}일</div></div>
          <div class="tile"><div class="k">기도</div><div class="v">${counts.prayer}<span class="small muted"> / ${daysPast}일</span></div></div>
          <div class="tile"><div class="k">위클릭</div><div class="v">${counts.weclick}<span class="small muted"> / ${daysPast}일</span></div></div>
          <div class="tile"><div class="k">3분말씀</div><div class="v">${counts.word}<span class="small muted"> / ${daysPast}일</span></div></div>
        </div>
        <div class="card">
          <div class="cal-head">
            <a class="btn icon sm" href="#/history?month=${prevMonth}" aria-label="이전 달">‹</a>
            <div class="m">${y}년 ${m}월</div>
            ${nextMonth <= today.slice(0, 7) ? `<a class="btn icon sm" href="#/history?month=${nextMonth}" aria-label="다음 달">›</a>` : '<span style="width:32px"></span>'}
          </div>
          <div class="calendar">${DOW.map((d) => `<div class="dow">${d}</div>`).join('')}${cal()}</div>
          <div class="legend"><span>● 기도 · 위클릭 · 3분말씀 순서</span><span>이번 달 체크 ${totalChecks}개</span></div>
        </div>
        <div class="card" id="detail">${detail()}</div>`;
      ctx.view.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => { sel = b.dataset.d; render(); document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }));
      ctx.view.querySelectorAll('[data-ph]').forEach((img) => img.addEventListener('click', () => {
        const c = byDate[sel];
        const list = ITEMS.filter((i) => c[i]).map((i) => ({ id: c[i], caption: `${LABEL[i]} · ${fmtDate(sel)}` }));
        openLightbox(list, list.findIndex((p) => p.id === c[img.dataset.ph]));
      }));
    }
    render();
  }

  // ---------- PIN 변경 ----------
  function pageAccount(ctx) {
    document.title = 'PIN 변경 · 화정 찬양부';
    ctx.view.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">PIN 변경</h1><p class="page-sub">${esc(state.me.name)} 님의 로그인 PIN</p></div></div>
      <div class="card" style="max-width:420px">
        <form id="pinf" novalidate>
          ${fieldHtml({ name: 'current', label: '현재 PIN', type: 'pin' })}
          ${fieldHtml({ name: 'next', label: '새 PIN', type: 'pin' })}
          ${fieldHtml({ name: 'next2', label: '새 PIN 확인', type: 'pin' })}
          <div class="error-text" id="perr"></div>
          <button class="btn primary" type="submit">변경하기</button>
        </form>
      </div>`;
    const form = document.getElementById('pinf');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      const err = document.getElementById('perr');
      err.textContent = '';
      try {
        checkPin(v.next);
        if (v.next !== v.next2) throw new Error('새 PIN이 서로 다릅니다.');
        await api('POST', '/api/me/pin', { current: v.current, next: v.next });
        form.reset();
        toast('PIN을 변경했어요.');
      } catch (x) { err.textContent = x.message; }
    });
  }

  // ---------- 통계 ----------
  function currentPeriod() {
    const s = state.stats;
    if (!s.weekStart) s.weekStart = mondayOf(kstToday());
    if (!s.start) { s.end = kstToday(); s.start = addDays(s.end, -27); }
    return s.mode === 'week' ? { start: s.weekStart, end: addDays(s.weekStart, 6) } : { start: s.start, end: s.end };
  }

  function barsHtml(rates) {
    const row = (label, v, cls = '') => `<div class="bar-row ${cls}"><span>${label}</span><div class="bar"><span style="width:${v || 0}%"></span></div><span class="v">${pct(v)}</span></div>`;
    return `<div class="bars">${ITEMS.map((i) => row(LABEL[i], rates[i])).join('')}${row('전체', rates.total, 'total')}</div>`;
  }

  function periodBarHtml() {
    const s = state.stats;
    const p = currentPeriod();
    return `<div class="period-bar">
      <div class="seg" role="tablist"><button data-mode="week" class="${s.mode === 'week' ? 'on' : ''}">주간</button><button data-mode="range" class="${s.mode === 'range' ? 'on' : ''}">기간</button></div>
      ${s.mode === 'week'
        ? `<div class="week-nav"><button class="btn icon sm" data-wk="-1" aria-label="이전 주">‹</button><span class="label">${fmtRange(p.start, p.end)}</span><button class="btn icon sm" data-wk="1" aria-label="다음 주">›</button>${s.weekStart !== mondayOf(kstToday()) ? '<button class="btn sm ghost" data-wk="0">이번 주</button>' : ''}</div>`
        : `<form class="range-inputs" id="rangef"><input class="input sm" type="date" name="start" value="${p.start}" max="${kstToday()}" aria-label="시작일"><span>~</span><input class="input sm" type="date" name="end" value="${p.end}" aria-label="종료일"><button class="btn sm primary" type="submit">조회</button></form>`}
    </div>`;
  }

  function bindPeriodBar(root, rerender) {
    const s = state.stats;
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { s.mode = b.dataset.mode; rerender(); }));
    root.querySelectorAll('[data-wk]').forEach((b) => b.addEventListener('click', () => {
      const n = Number(b.dataset.wk);
      s.weekStart = n === 0 ? mondayOf(kstToday()) : addDays(s.weekStart, 7 * n);
      rerender();
    }));
    const f = root.querySelector('#rangef');
    if (f) f.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      if (!v.start || !v.end) return toast('시작일과 종료일을 선택해 주세요.', true);
      if (v.start > v.end) return toast('시작일이 종료일보다 늦어요.', true);
      s.start = v.start; s.end = v.end; rerender();
    });
  }

  function periodNote(d) {
    const fut = d.effectiveEnd < d.end;
    return `<p class="calc-note">달성률 = 완료한 체크 수 ÷ (해당 기간 실제 소속 성도별 체크 기회)${fut ? ` · ${fmtShort(addDays(d.effectiveEnd, 1))} 이후 미래 날짜는 제외` : ''}</p>`;
  }

  async function pageStats(ctx) {
    document.title = '통계 · 화정 찬양부';
    const p = currentPeriod();
    const data = await api('GET', `/api/admin/stats?start=${p.start}&end=${p.end}`);
    if (!ctx.alive()) return;
    const rerender = () => route();
    const notStarted = data.days === 0;
    ctx.view.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">통계</h1><p class="page-sub">팀별 · 찬양부 전체 달성률</p></div>
        <a class="btn soft" href="/api/admin/stats.csv?start=${p.start}&end=${p.end}" download>⬇ CSV 다운로드</a></div>
      ${periodBarHtml()}
      ${notStarted ? '<div class="card empty">아직 시작되지 않은 기간이에요.</div>' : `
      <div class="card">
        <div class="overall">
          <div><div class="muted small">찬양부 전체 달성률</div><div class="rate-big">${data.overall.rates.total == null ? '–' : data.overall.rates.total}<small>${data.overall.rates.total == null ? '' : '%'}</small></div>
            <div class="muted small">${data.overall.memberCount}명 · ${data.days}일 · 완료 ${data.overall.totalDone} / ${data.overall.opportunities * 3}</div></div>
          ${barsHtml(data.overall.rates)}
        </div>
        ${periodNote(data)}
      </div>
      <div class="section">
        <h2 class="section-title">팀별 달성률</h2>
        ${data.teams.length ? `<div class="team-grid">${data.teams.map((t) => `
          <button type="button" class="card team-stat" data-team="${t.id}">
            <div class="top"><span class="name">${esc(t.name)} ${t.deleted ? '<span class="badge">삭제된 팀</span>' : ''}</span><span class="rate">${pct(t.rates.total)}</span></div>
            <div class="meta">${t.memberCount}명 · 체크 기회 ${t.opportunities}회 · 자세히 보기 ›</div>
            ${barsHtml(t.rates)}
          </button>`).join('')}</div>` : '<div class="card empty">팀이 없어요. 팀 관리에서 팀을 만들어 주세요.</div>'}
      </div>`}`;
    bindPeriodBar(ctx.view, rerender);
    ctx.view.querySelectorAll('[data-team]').forEach((b) => b.addEventListener('click', () => go(`#/stats/team/${b.dataset.team}`)));
  }

  async function pageTeamDetail(ctx) {
    const teamId = ctx.parts[2];
    const p = currentPeriod();
    const data = await api('GET', `/api/admin/stats/team/${teamId}?start=${p.start}&end=${p.end}`);
    if (!ctx.alive()) return;
    document.title = `${data.team.name} · 통계 · 화정 찬양부`;
    const pages = [];
    for (let k = 0; k < data.dates.length; k += 7) pages.push(data.dates.slice(k, k + 7));
    let pageIdx = Math.max(0, pages.length - 1);
    const dailyMap = Object.fromEntries(data.daily.map((d) => [d.date, d]));

    function dayTh(d) { const w = dow(d); return `<th class="${w === 0 ? 'dow-sun' : w === 6 ? 'dow-sat' : ''}">${fmtShort(d)}<br><span class="small">${DOW[w]}</span></th>`; }

    function render() {
      const dates = pages[pageIdx] || [];
      const pager = pages.length > 1 ? `<div class="pager"><button class="btn icon sm" data-pg="-1" ${pageIdx === 0 ? 'disabled' : ''} aria-label="이전 7일">‹</button>
        <span class="label">${fmtRange(dates[0], dates[dates.length - 1])} <span class="muted small">(${pageIdx + 1}/${pages.length})</span></span>
        <button class="btn icon sm" data-pg="1" ${pageIdx === pages.length - 1 ? 'disabled' : ''} aria-label="다음 7일">›</button></div>` : '';
      const s = data.summary;
      ctx.view.innerHTML = `
        <div class="page-head"><div>
          <a href="#/stats" class="btn sm ghost" style="margin-left:-10px">‹ 통계로</a>
          <h1 class="page-title">${esc(data.team.name)} ${data.team.deleted ? '<span class="badge">삭제된 팀</span>' : ''}</h1>
          <p class="page-sub">팀 상세 통계</p></div>
          <a class="btn soft" href="/api/admin/stats.csv?start=${p.start}&end=${p.end}" download>⬇ CSV 다운로드</a></div>
        ${periodBarHtml()}
        ${!data.dates.length ? '<div class="card empty">아직 시작되지 않은 기간이에요.</div>' : `
        <div class="card">
          <div class="overall">
            <div><div class="muted small">팀 전체 달성률 (선택 기간 전체)</div><div class="rate-big">${s.rates.total == null ? '–' : s.rates.total}<small>${s.rates.total == null ? '' : '%'}</small></div>
              <div class="muted small">${s.memberCount}명 · ${data.dates.length}일 · 완료 ${s.totalDone} / ${s.opportunities * 3}</div></div>
            ${barsHtml(s.rates)}
          </div>
          ${periodNote(data)}
        </div>
        <div class="section">
          <h2 class="section-title">날짜별 완료 인원</h2>
          ${pager}
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th class="l">날짜</th><th>소속 인원</th>${ITEMS.map((i) => `<th>${LABEL[i]}</th>`).join('')}<th>3개 모두</th></tr></thead>
            <tbody>${dates.map((d) => { const r = dailyMap[d]; return `<tr><td class="l">${esc(fmtDate(d))}</td><td>${r.members}명</td>${ITEMS.map((i) => `<td>${r.done[i]}명</td>`).join('')}<td><b>${r.allDone}명</b></td></tr>`; }).join('')}</tbody>
            <tfoot><tr><td class="l">기간 합계</td><td>${s.opportunities}회</td>${ITEMS.map((i) => `<td>${s.done[i]}회 · ${pct(s.rates[i])}</td>`).join('')}<td>${data.daily.reduce((a, r) => a + r.allDone, 0)}회</td></tr></tfoot>
          </table></div>
        </div>
        <div class="section">
          <h2 class="section-title">성도별 · 항목별 체크표</h2>
          ${pager}
          ${data.members.length ? `<div class="table-wrap"><table class="tbl">
            <thead><tr><th class="l sticky-col">성도</th>${dates.map(dayTh).join('')}<th>기도</th><th>위클릭</th><th>3분말씀</th><th>전체</th><th>사진</th></tr></thead>
            <tbody>${data.members.map((m) => `<tr>
              <td class="l sticky-col"><b>${esc(m.name)}</b></td>
              ${dates.map((d) => { const c = m.cells[d]; if (!c) return '<td><span class="marks">' + ITEMS.map(() => '<span class="mark na">·</span>').join('') + '</span></td>'; return `<td><span class="marks">${ITEMS.map((i) => c[i] ? `<button type="button" class="mark on" data-photo="${c[i]}" data-cap="${esc(m.name)} · ${esc(fmtDate(d))} · ${LABEL[i]}" title="${LABEL[i]} 사진 보기">${SHORT[i]}</button>` : `<span class="mark" title="${LABEL[i]} 미체크">${SHORT[i]}</span>`).join('')}</span></td>`; }).join('')}
              ${ITEMS.map((i) => `<td>${m.done[i]}/${m.opportunities}</td>`).join('')}
              <td><b>${pct(m.rates.total)}</b></td>
              <td><button class="btn icon sm ghost" data-cam="${m.userId}" title="${esc(m.name)} 사진 보기" aria-label="${esc(m.name)} 사진 보기">📷</button></td>
            </tr>`).join('')}</tbody>
          </table></div>
          <p class="calc-note">기 = 기도 · 위 = 위클릭 · 말 = 3분말씀 · 초록 칸을 누르면 사진을 볼 수 있어요. 합계는 선택한 전체 기간 기준입니다. 빈 점(·)은 그날 이 팀 소속이 아니었던 날이에요.</p>`
          : '<div class="card empty">이 기간에 소속된 성도가 없어요.</div>'}
        </div>`}`;
      bindPeriodBar(ctx.view, () => route());
      ctx.view.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { pageIdx += Number(b.dataset.pg); render(); }));
      ctx.view.querySelectorAll('[data-photo]').forEach((b) => b.addEventListener('click', () => {
        const all = [...ctx.view.querySelectorAll('[data-photo]')];
        const row = all.filter((x) => x.closest('tr') === b.closest('tr'));
        openLightbox(row.map((x) => ({ id: Number(x.dataset.photo), caption: x.dataset.cap })), row.indexOf(b));
      }));
      ctx.view.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => go(`#/photos?user=${b.dataset.cam}&start=${p.start}&end=${data.effectiveEnd}`)));
    }
    render();
  }

  // ---------- 성도 관리 ----------
  async function loadTeams() { return api('GET', '/api/admin/teams'); }

  function teamOptions(teams, withNone = true) {
    return [...(withNone ? [{ value: '', label: '소속 팀 없음' }] : []), ...teams.map((t) => ({ value: t.id, label: t.name }))];
  }

  function addUserModal(teams, presetTeamId, after) {
    return formModal({
      title: '새 성도 등록',
      submit: '등록',
      fields: [
        { name: 'name', label: '이름', placeholder: '예: 홍길동' },
        { name: 'pin', label: '로그인 PIN', type: 'pin' },
        { name: 'teamId', label: '팀', type: 'select', options: teamOptions(teams), value: presetTeamId || '' },
        { name: 'role', label: '권한', type: 'select', options: [{ value: 'member', label: '일반 성도' }, { value: 'admin', label: '관리자' }], value: 'member' },
      ],
      async onSubmit(v) {
        if (!v.name.trim()) throw new Error('이름을 입력해 주세요.');
        checkPin(v.pin);
        await api('POST', '/api/admin/users', v);
        toast(`${v.name.trim()} 님을 등록했어요.`);
        after();
      },
    });
  }

  async function pageMembers(ctx) {
    document.title = '성도 관리 · 화정 찬양부';
    const [{ users }, { teams }] = await Promise.all([api('GET', '/api/admin/users'), loadTeams()]);
    if (!ctx.alive()) return;
    let filter = { q: '', team: '' };
    const reload = () => { refreshMe(); route(); };

    function list() {
      const q = filter.q.trim().toLowerCase();
      return users.filter((u) => (!q || u.name.toLowerCase().includes(q))
        && (!filter.team || (filter.team === 'none' ? !u.team_id : String(u.team_id) === filter.team)));
    }

    function rowsHtml() {
      const l = list();
      if (!l.length) return '<div class="card empty">해당하는 성도가 없어요.</div>';
      return l.map((u) => `
        <div class="card user-row${u.active ? '' : ' inactive'}">
          <div class="avatar">${esc(u.name.slice(0, 1))}</div>
          <div class="user-info">
            <div class="nm">${esc(u.name)}${u.role === 'admin' ? ' <span class="badge gold">관리자</span>' : ''}${u.active ? '' : ' <span class="badge red">비활성</span>'}${u.id === state.me.id ? ' <span class="badge">나</span>' : ''}</div>
            <div class="sub">${u.team_name ? esc(u.team_name) : '소속 팀 없음'}${u.active ? ` · 오늘 ${u.today_count}/3` : ''}</div>
          </div>
          <div class="user-actions">
            <button class="btn sm" data-act="edit" data-id="${u.id}">수정</button>
            <button class="btn sm" data-act="team" data-id="${u.id}">팀 배정</button>
            <button class="btn sm" data-act="pin" data-id="${u.id}">PIN 재설정</button>
            <button class="btn sm soft" data-act="photos" data-id="${u.id}">📷 사진</button>
            ${u.id === state.me.id ? '' : `<button class="btn sm" data-act="active" data-id="${u.id}">${u.active ? '비활성화' : '활성화'}</button>
            <button class="btn sm danger" data-act="delete" data-id="${u.id}">삭제</button>`}
          </div>
        </div>`).join('');
    }

    ctx.view.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">성도 관리</h1><p class="page-sub">전체 ${users.length}명 · 활성 ${users.filter((u) => u.active).length}명</p></div>
        <button class="btn primary" id="add-user">+ 성도 추가</button></div>
      <div class="toolbar">
        <input class="input sm" id="uq" placeholder="이름 검색" type="search">
        <select class="input sm" id="ut"><option value="">모든 팀</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}<option value="none">소속 팀 없음</option></select>
      </div>
      <div class="user-list" id="ulist">${rowsHtml()}</div>`;

    const $list = document.getElementById('ulist');
    document.getElementById('uq').addEventListener('input', (e) => { filter.q = e.target.value; $list.innerHTML = rowsHtml(); });
    document.getElementById('ut').addEventListener('change', (e) => { filter.team = e.target.value; $list.innerHTML = rowsHtml(); });
    document.getElementById('add-user').addEventListener('click', () => addUserModal(teams, '', reload));

    $list.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const u = users.find((x) => x.id === Number(b.dataset.id));
      if (!u) return;
      const act = b.dataset.act;
      if (act === 'edit') {
        formModal({
          title: '성도 정보 수정',
          fields: [
            { name: 'name', label: '이름', value: u.name },
            { name: 'role', label: '권한', type: 'select', options: [{ value: 'member', label: '일반 성도' }, { value: 'admin', label: '관리자' }], value: u.role },
          ],
          async onSubmit(v) { if (!v.name.trim()) throw new Error('이름을 입력해 주세요.'); await api('PATCH', `/api/admin/users/${u.id}`, v); toast('저장했어요.'); reload(); },
        });
      } else if (act === 'team') {
        if (!u.active) return toast('비활성화된 성도는 먼저 활성화해 주세요.', true);
        formModal({
          title: `${u.name} 님 팀 배정`,
          submit: '배정',
          fields: [{ name: 'teamId', label: '팀', type: 'select', options: teamOptions(teams), value: u.team_id || '' }],
          extra: '<p class="muted small">팀을 옮겨도 이전 팀에서의 기록과 통계는 그대로 남아요. 오늘부터 새 팀으로 집계됩니다.</p>',
          async onSubmit(v) { await api('PUT', `/api/admin/users/${u.id}/team`, { teamId: v.teamId || null }); toast('팀을 배정했어요.'); reload(); },
        });
      } else if (act === 'pin') {
        formModal({
          title: `${u.name} 님 PIN 재설정`,
          submit: '재설정',
          fields: [{ name: 'pin', label: '새 PIN', type: 'pin' }],
          async onSubmit(v) { checkPin(v.pin); await api('POST', `/api/admin/users/${u.id}/pin`, { pin: v.pin }); toast('PIN을 재설정했어요.'); },
        });
      } else if (act === 'photos') {
        const end = kstToday();
        go(`#/photos?user=${u.id}&start=${addDays(end, -6)}&end=${end}`);
      } else if (act === 'active') {
        const ok = await confirmDialog(u.active
          ? { title: '성도 비활성화', message: `<b>${esc(u.name)}</b> 님을 비활성화할까요?<br>로그인할 수 없게 되고, 오늘부터 통계 집계에서 빠집니다. 지난 기록은 유지돼요.`, ok: '비활성화', danger: true }
          : { title: '성도 활성화', message: `<b>${esc(u.name)}</b> 님을 다시 활성화할까요?`, ok: '활성화' });
        if (!ok) return;
        try { await api('POST', `/api/admin/users/${u.id}/active`, { active: !u.active }); toast(u.active ? '비활성화했어요.' : '활성화했어요.'); reload(); } catch (x) { toastErr(x); }
      } else if (act === 'delete') {
        const ok = await confirmDialog({ title: '성도 삭제', message: `<b>${esc(u.name)}</b> 님의 계정과 모든 체크 기록, 사진이 <b>영구 삭제</b>됩니다.<br>삭제 후에는 되돌릴 수 없어요. 삭제할까요?`, ok: '영구 삭제', danger: true });
        if (!ok) return;
        try { await api('DELETE', `/api/admin/users/${u.id}`); toast('삭제했어요.'); reload(); } catch (x) { toastErr(x); }
      }
    });
  }

  // ---------- 팀 관리 ----------
  async function pageTeams(ctx) {
    document.title = '팀 관리 · 화정 찬양부';
    const [{ teams, deletedTeams }, { users }] = await Promise.all([loadTeams(), api('GET', '/api/admin/users')]);
    if (!ctx.alive()) return;
    const reload = () => { refreshMe(); route(); };

    ctx.view.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">팀 관리</h1><p class="page-sub">팀 ${teams.length}개 · 팀 미배정 ${users.filter((u) => u.active && !u.team_id).length}명</p></div>
        <button class="btn primary" id="add-team">+ 팀 추가</button></div>
      ${teams.length ? `<div class="team-grid">${teams.map((t) => `
        <div class="card team-card">
          <div class="head">
            <span class="name">${esc(t.name)}</span><span class="badge green">${t.members.length}명</span>
            <button class="btn icon sm ghost" data-edit="${t.id}" title="팀 이름 수정" aria-label="팀 이름 수정">✎</button>
            <button class="btn icon sm ghost" data-del="${t.id}" title="팀 삭제" aria-label="팀 삭제" style="color:var(--danger)">🗑</button>
          </div>
          <div class="chips">
            ${t.members.map((m) => `<span class="chip">${esc(m.name)}${m.role === 'admin' ? ' <span class="badge gold" style="padding:0 6px">관리자</span>' : ''}<button data-rm="${m.id}" data-team="${t.id}" title="팀에서 빼기" aria-label="${esc(m.name)} 팀에서 빼기">×</button></span>`).join('')}
            <button class="add-chip" data-add="${t.id}" title="성도 추가" aria-label="${esc(t.name)}에 성도 추가">+</button>
          </div>
          ${t.members.length ? '' : '<div class="muted small">아직 소속 성도가 없어요. + 버튼으로 추가해 주세요.</div>'}
        </div>`).join('')}</div>` : '<div class="card empty">아직 팀이 없어요. 오른쪽 위 ‘+ 팀 추가’로 첫 팀을 만들어 주세요.</div>'}
      ${deletedTeams.length ? `<div class="section"><h2 class="section-title">삭제된 팀</h2>
        <div class="card" style="padding:4px 0">${deletedTeams.map((t) => `<div class="deleted-row"><span class="grow">${esc(t.name)} <span class="muted small">· ${esc(t.deletedAt.slice(0, 10))} 삭제</span></span><button class="btn sm soft" data-restore="${t.id}">복구</button></div>`).join('')}</div>
        <p class="calc-note">삭제된 팀의 지난 통계는 그대로 유지됩니다. 복구한 뒤 성도를 다시 추가해 주세요.</p></div>` : ''}`;

    document.getElementById('add-team').addEventListener('click', () => formModal({
      title: '팀 추가', submit: '추가', fields: [{ name: 'name', label: '팀 이름', placeholder: '예: 소프라노, 1팀' }],
      async onSubmit(v) { if (!v.name.trim()) throw new Error('팀 이름을 입력해 주세요.'); await api('POST', '/api/admin/teams', v); toast('팀을 추가했어요.'); reload(); },
    }));

    ctx.view.addEventListener('click', async (e) => {
      const t = (id) => teams.find((x) => x.id === Number(id));
      let b;
      if ((b = e.target.closest('[data-edit]'))) {
        const team = t(b.dataset.edit);
        formModal({
          title: '팀 이름 수정', fields: [{ name: 'name', label: '팀 이름', value: team.name }],
          async onSubmit(v) { if (!v.name.trim()) throw new Error('팀 이름을 입력해 주세요.'); await api('PATCH', `/api/admin/teams/${team.id}`, v); toast('저장했어요.'); reload(); },
        });
      } else if ((b = e.target.closest('[data-del]'))) {
        const team = t(b.dataset.del);
        const ok = await confirmDialog({ title: '팀 삭제', message: `<b>${esc(team.name)}</b> 팀을 삭제할까요?<br>소속 성도 ${team.members.length}명은 ‘소속 팀 없음’이 되며, 성도 계정과 지난 통계는 그대로 유지됩니다. 삭제된 팀은 다시 복구할 수 있어요.`, ok: '삭제', danger: true });
        if (!ok) return;
        try { await api('DELETE', `/api/admin/teams/${team.id}`); toast('팀을 삭제했어요.'); reload(); } catch (x) { toastErr(x); }
      } else if ((b = e.target.closest('[data-restore]'))) {
        try { await api('POST', `/api/admin/teams/${b.dataset.restore}/restore`); toast('팀을 복구했어요.'); reload(); } catch (x) { toastErr(x); }
      } else if ((b = e.target.closest('[data-rm]'))) {
        const team = t(b.dataset.team);
        const member = team.members.find((m) => m.id === Number(b.dataset.rm));
        const ok = await confirmDialog({ title: '팀에서 빼기', message: `<b>${esc(member.name)}</b> 님을 <b>${esc(team.name)}</b> 팀에서 뺄까요?<br>지난 기록과 통계는 유지돼요.`, ok: '빼기', danger: true });
        if (!ok) return;
        try { await api('PUT', `/api/admin/users/${member.id}/team`, { teamId: null }); toast('팀에서 뺐어요.'); reload(); } catch (x) { toastErr(x); }
      } else if ((b = e.target.closest('[data-add]'))) {
        addMembersModal(t(b.dataset.add));
      }
    });

    function addMembersModal(team) {
      const candidates = users.filter((u) => u.active && u.team_id !== team.id);
      let tab = 'existing';
      const m = openModal('<div data-body></div>', { wide: true });
      const body = m.el.querySelector('[data-body]');
      function render() {
        body.innerHTML = `
          <h2>${esc(team.name)}에 성도 추가</h2>
          <div class="tabs"><button data-tab="existing" class="${tab === 'existing' ? 'on' : ''}">기존 성도 추가</button><button data-tab="new" class="${tab === 'new' ? 'on' : ''}">새 성도 등록</button></div>
          ${tab === 'existing' ? `
            ${candidates.length ? `<input class="input sm" placeholder="이름 검색" data-search type="search" style="margin-bottom:8px">
            <div class="pick-list">${candidates.map((u) => `<label class="pick" data-name="${esc(u.name.toLowerCase())}"><input type="checkbox" value="${u.id}"><span>${esc(u.name)}</span><span class="sub">${u.team_name ? `${esc(u.team_name)}에서 이동` : '소속 팀 없음'}</span></label>`).join('')}</div>
            <p class="muted small" style="margin:8px 0 0">다른 팀 성도를 선택하면 오늘부터 이 팀으로 이동하며, 이전 팀의 기록은 유지돼요.</p>` : '<div class="empty">추가할 수 있는 성도가 없어요. ‘새 성도 등록’ 탭에서 등록해 주세요.</div>'}
            <div class="error-text" data-err></div>
            <div class="actions"><button class="btn" data-close>닫기</button>${candidates.length ? '<button class="btn primary" data-addsel>선택한 성도 추가</button>' : ''}</div>`
          : `<form data-newf novalidate>
              ${fieldHtml({ name: 'name', label: '이름', placeholder: '예: 홍길동' })}
              ${fieldHtml({ name: 'pin', label: '로그인 PIN', type: 'pin' })}
              ${fieldHtml({ name: 'role', label: '권한', type: 'select', options: [{ value: 'member', label: '일반 성도' }, { value: 'admin', label: '관리자' }], value: 'member' })}
              <div class="error-text" data-err></div>
              <div class="actions"><button type="button" class="btn" data-close>닫기</button><button class="btn primary" type="submit">등록하고 팀에 추가</button></div>
            </form>`}`;
        body.querySelectorAll('[data-close]').forEach((x) => x.addEventListener('click', m.close));
        body.querySelectorAll('[data-tab]').forEach((x) => x.addEventListener('click', () => { tab = x.dataset.tab; render(); }));
        const search = body.querySelector('[data-search]');
        if (search) search.addEventListener('input', () => {
          const q = search.value.trim().toLowerCase();
          body.querySelectorAll('.pick').forEach((p) => { p.style.display = !q || p.dataset.name.includes(q) ? '' : 'none'; });
        });
        const addBtn = body.querySelector('[data-addsel]');
        if (addBtn) addBtn.addEventListener('click', async () => {
          const ids = [...body.querySelectorAll('.pick input:checked')].map((x) => Number(x.value));
          if (!ids.length) { body.querySelector('[data-err]').textContent = '추가할 성도를 선택해 주세요.'; return; }
          addBtn.disabled = true;
          try { await api('POST', `/api/admin/teams/${team.id}/members`, { userIds: ids }); m.close(); toast(`${ids.length}명을 추가했어요.`); reload(); } catch (x) { body.querySelector('[data-err]').textContent = x.message; addBtn.disabled = false; }
        });
        const nf = body.querySelector('[data-newf]');
        if (nf) nf.addEventListener('submit', async (e) => {
          e.preventDefault();
          const v = Object.fromEntries(new FormData(nf));
          try {
            if (!v.name.trim()) throw new Error('이름을 입력해 주세요.');
            checkPin(v.pin);
            await api('POST', '/api/admin/users', { ...v, teamId: team.id });
            m.close(); toast(`${v.name.trim()} 님을 등록했어요.`); reload();
          } catch (x) { nf.querySelector('[data-err]').textContent = x.message; }
        });
      }
      render();
    }
  }

  // ---------- 사진 확인 ----------
  async function pagePhotos(ctx) {
    document.title = '사진 확인 · 화정 찬양부';
    const today = kstToday();
    const q = ctx.q;
    const start = /^\d{4}-\d{2}-\d{2}$/.test(q.start || '') ? q.start : addDays(today, -6);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(q.end || '') ? q.end : today;
    const userId = q.user || '';
    const item = ITEMS.includes(q.item) ? q.item : '';
    const qs = new URLSearchParams({ start, end });
    if (userId) qs.set('userId', userId);
    if (item) qs.set('item', item);
    const [{ users }, res] = await Promise.all([
      api('GET', '/api/admin/users'),
      start <= end ? api('GET', `/api/admin/photos?${qs}`) : Promise.resolve({ photos: [], truncated: false }),
    ]);
    if (!ctx.alive()) return;
    const photos = res.photos;
    const selUser = users.find((u) => String(u.id) === String(userId));

    // 날짜 → 성도 → 항목
    const groups = [];
    const gmap = new Map();
    for (const p of photos) {
      if (!gmap.has(p.date)) { const g = { date: p.date, users: new Map() }; gmap.set(p.date, g); groups.push(g); }
      const g = gmap.get(p.date);
      if (!g.users.has(p.user_id)) g.users.set(p.user_id, { name: p.user_name, items: {} });
      g.users.get(p.user_id).items[p.item] = p;
    }
    const flat = [];
    for (const g of groups) for (const u of g.users.values()) for (const i of ITEMS) if (u.items[i]) flat.push({ id: u.items[i].id, caption: `${u.name} · ${fmtDate(g.date)} · ${LABEL[i]}` });

    const shownItems = item ? [item] : ITEMS;
    ctx.view.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">사진 확인</h1><p class="page-sub">${selUser ? `${esc(selUser.name)} 님 · ` : ''}${fmtRange(start, end)} · 사진 ${photos.length}장</p></div></div>
      <form class="card filters" id="pf">
        <div class="field"><label>성도</label><select class="input sm" name="user"><option value="">전체 성도</option>${users.map((u) => `<option value="${u.id}"${String(u.id) === String(userId) ? ' selected' : ''}>${esc(u.name)}${u.team_name ? ` (${esc(u.team_name)})` : ''}</option>`).join('')}</select></div>
        <div class="field"><label>항목</label><select class="input sm" name="item"><option value="">전체 항목</option>${ITEMS.map((i) => `<option value="${i}"${i === item ? ' selected' : ''}>${LABEL[i]}</option>`).join('')}</select></div>
        <div class="field"><label>시작일</label><input class="input sm" type="date" name="start" value="${start}"></div>
        <div class="field"><label>종료일</label><input class="input sm" type="date" name="end" value="${end}"></div>
        <div class="field"><button class="btn primary" type="submit">조회</button></div>
      </form>
      ${res.truncated ? '<div class="notice">사진이 너무 많아 최근 2,000장만 표시합니다. 기간이나 성도를 좁혀 주세요.</div>' : ''}
      ${groups.length ? groups.map((g) => `
        <div class="photo-day"><h3>${esc(fmtDate(g.date, true))}</h3>
          <div class="card" style="padding:0">${[...g.users.values()].map((u) => `
            <div class="photo-user"><div class="who">${esc(u.name)}</div><div class="thumbs">${shownItems.map((i) => u.items[i]
              ? `<button type="button" class="thumb" data-pid="${u.items[i].id}"><img src="${photoUrl(u.items[i].id, u.items[i].has_thumb)}" alt="${LABEL[i]}" loading="lazy"><span class="tag">${LABEL[i]}</span></button>`
              : `<div class="thumb missing">${LABEL[i]}<br>없음</div>`).join('')}</div></div>`).join('')}
          </div></div>`).join('') : '<div class="card empty">이 기간에 올라온 사진이 없어요.</div>'}`;

    const f = document.getElementById('pf');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      if (!v.start || !v.end) return toast('시작일과 종료일을 선택해 주세요.', true);
      if (v.start > v.end) return toast('시작일이 종료일보다 늦어요.', true);
      const p = new URLSearchParams();
      for (const k of ['user', 'item', 'start', 'end']) if (v[k]) p.set(k, v[k]);
      go(`#/photos?${p}`);
    });
    ctx.view.querySelectorAll('[data-pid]').forEach((b) => b.addEventListener('click', () => {
      openLightbox(flat, flat.findIndex((x) => x.id === Number(b.dataset.pid)));
    }));
  }

  window.addEventListener('hashchange', route);
  boot();
})();
