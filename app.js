const API = '';
const DOMAIN = 'nevixmail.com';
const S = {
  token: localStorage.getItem('nevixmail.token') || '',
  me: null,
  scr: 'boot',
  box: 'inbox',
  q: '',
  open: null,
  draft: null,
  unread: 0,
  nevixLogin: false,
  nevixForm: false,
  notif: localStorage.getItem('nevixmail.notif') !== '0'
};
const $ = (s) => document.querySelector(s);
const app = $('#app');
const ic = (n, s = 24) => {
  const P = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
    edit: '<path d="M4 20h4L20 8l-4-4L4 16zM14 6l4 4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    user: '<circle cx="12" cy="9" r="4"/><path d="M4 21c1-5 15-5 16 0"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    restore: '<path d="M4 12a8 8 0 1 1 3 6.2M4 20v-5h5"/>'
  };
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
};
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BOX = { inbox: 'Входящие', sent: 'Отправленные', drafts: 'Черновики', spam: 'Спам', trash: 'Корзина' };

function say(t) {
  const old = $('.toast');
  if (old) old.remove();
  const e = document.createElement('div');
  e.className = 'toast';
  e.setAttribute('role', 'status');
  e.textContent = t;
  app.append(e);
  setTimeout(() => e.remove(), 2400);
}

function fmt(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

async function api(path, opts) {
  opts = opts || {};
  const headers = { 'content-type': 'application/json' };
  if (S.token) headers.authorization = 'Bearer ' + S.token;
  const r = await fetch(API + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let d = {};
  try { d = await r.json(); } catch (e) {}
  if (!r.ok) {
    const err = new Error(d.error || 'Ошибка связи');
    err.status = r.status;
    err.field = d.field;
    throw err;
  }
  return d;
}

/* ─────────── экраны ─────────── */
const nav = (a) => `<nav class="nav">${[
  ['list', 'list', 'Письма'],
  ['compose', 'edit', 'Написать'],
  ['settings', 'gear', 'Настройки']
].map(([k, i, l]) => `<button data-go="${k}" class="${a === k ? 'on' : ''}" aria-label="${l}">${ic(i === 'list' ? 'mail' : i, 26)}</button>`).join('')}</nav>`;

const suf = `<span class="m">@${DOMAIN}</span>`;

function viewLogin() {
  return `<div class="scr" style="justify-content:center;gap:16px">
    <div class="logo"><b>N</b>NEVIX MAIL</div>
    <h1 style="margin:14px 0 0;font-size:28px">Вход</h1>
    <div><label for="h">Адрес</label><div class="f"><input id="h" autocapitalize="none" autocomplete="username" placeholder="имя">${suf}</div></div>
    <div><label for="pw">Пароль</label><div class="f"><input id="pw" type="password" autocomplete="current-password"></div></div>
    <div class="err" id="err" role="alert"></div>
    <button class="b" data-act="login">Войти</button>
    ${S.nevixLogin ? (S.nevixForm ? `
      <div style="height:1px;background:var(--ln);margin:2px 0"></div>
      <div><label for="nh">Имя в мессенджере NEVIX</label><div class="f"><input id="nh" autocapitalize="none" placeholder="Ваше имя"></div></div>
      <div><label for="np">Пароль от мессенджера</label><div class="f"><input id="np" type="password"></div></div>
      <button class="b" data-act="nevixlogin" style="background:#2b1418">Войти через NEVIX</button>
    ` : `<button class="b g" data-act="nevixtoggle">Войти через мессенджер NEVIX</button>`) : ''}
    <button class="b g" data-act="toreg">У меня ещё нет адреса</button>
  </div>`;
}

function viewReg() {
  return `<div class="scr" style="justify-content:center;gap:16px">
    <div class="logo"><b>N</b>NEVIX MAIL</div>
    <h1 style="margin:14px 0 0;font-size:28px">Создать адрес</h1>
    <div><label for="h">Адрес</label><div class="f"><input id="h" autocapitalize="none" autocomplete="username" placeholder="имя">${suf}</div></div>
    <div><label for="pw">Пароль (от 6 символов)</label><div class="f"><input id="pw" type="password" autocomplete="new-password"></div></div>
    <div><label for="pw2">Повторите пароль</label><div class="f"><input id="pw2" type="password" autocomplete="new-password"></div></div>
    <div class="err" id="err" role="alert"></div>
    <button class="b" data-act="register">Создать</button>
    <button class="b g" data-act="tologin">У меня уже есть адрес</button>
  </div>`;
}

function viewList() {
  const box = S.box;
  return `<div class="scr">
    <div class="r"><div class="logo"><b>N</b>NEVIX MAIL</div>
      <button class="i" data-go="settings" aria-label="Профиль">${ic('user', 28)}</button></div>
    <div class="f" style="border-radius:28px;flex:none">${ic('search', 20)}<input id="q" aria-label="Поиск писем" placeholder="Поиск писем" value="${esc(S.q)}"></div>
    <div class="chips">${Object.entries(BOX).map(([k, v]) => `<button class="chip ${box === k ? 'on' : ''}" data-box="${k}">${v}</button>`).join('')}</div>
    <div class="r"><h2 style="margin:0;font-size:23px">${BOX[box]}</h2><span id="pill">${pillHtml()}</span></div>
    <button class="write" data-go="compose">${ic('mail', 24)}Написать письмо</button>
    <div id="list"><p class="m" style="text-align:center;margin-top:30px">Загружаю…</p></div>
  </div>${nav('list')}`;
}

function pillHtml() {
  if (S.box !== 'inbox' || !S.unread) return '';
  const n = S.unread;
  return `<span class="pill">${n} ${n === 1 ? 'новое' : 'новых'}</span>`;
}

function viewLetter() {
  const m = S.open;
  const out = m.outgoing;
  const inInbox = S.box === 'inbox';
  const inSpam = S.box === 'spam';
  const inTrash = S.box === 'trash';
  return `<div class="scr">
    <div class="r">
      <button class="i" data-go="list" aria-label="Назад">${ic('back')}</button>
      ${inInbox ? `<button class="i" data-act="trash" aria-label="В корзину">${ic('trash')}</button>` : ''}
      ${inSpam ? `<button class="i" data-act="restore" aria-label="Не спам">${ic('restore')}</button>` : ''}
    </div>
    <h1 style="margin:4px 0 0;font-size:25px">${esc(m.subj || '(без темы)')}</h1>
    <div class="r" style="justify-content:flex-start">
      <div class="av">${esc((out ? m.to : m.from)[0] || '?').toUpperCase()}</div>
      <div style="flex:1;min-width:0"><b>${esc(out ? m.to : m.from)}@${DOMAIN}</b>
        <div class="m" style="font-size:14px">${out ? 'от: вы' : 'кому: вы'}</div></div>
      <span class="m" style="font-size:14px">${fmt(m.ts)}</span>
    </div>
    <div style="height:1px;background:var(--ln)"></div>
    <div style="font-size:17px;line-height:1.5;flex:1;white-space:pre-wrap">${esc(m.body)}</div>
    <div class="two">
      ${inInbox ? `<button class="b g" data-act="reply">Ответить</button><button class="b g" data-act="spam">В спам</button>` : ''}
      ${inSpam ? `<button class="b g" data-act="restore">Не спам</button><button class="b g" data-act="gone">Удалить</button>` : ''}
      ${inTrash ? `<button class="b g" data-act="restore">Восстановить</button><button class="b g" data-act="gone">Удалить</button>` : ''}
      ${out ? `<button class="b g" data-act="trash">В корзину</button>` : ''}
    </div>
  </div>`;
}

function viewCompose() {
  const d = S.draft;
  return `<div class="scr">
    <div class="r">
      <button class="i" data-act="cancel" aria-label="Закрыть">${ic('x')}</button>
      <b style="font-size:18px">Новое письмо</b>
      <button class="i a" data-act="send" aria-label="Отправить">${ic('send', 24)}</button>
    </div>
    <div class="f"><span class="m">Кому</span><input id="to" autocapitalize="none" aria-label="Кому" placeholder="имя" value="${esc(d.to || '')}">${suf}</div>
    <div class="f"><span class="m">Тема</span><input id="subj" aria-label="Тема" value="${esc(d.subj || '')}"></div>
    <div class="f" style="flex:1;align-items:flex-start;padding-top:14px"><textarea id="body" aria-label="Текст письма" placeholder="Напишите письмо" style="height:100%;resize:none">${esc(d.body || '')}</textarea></div>
    <div class="err" id="err" role="alert"></div>
  </div>`;
}

function viewSettings() {
  const me = S.me;
  return `<div class="scr">
    <h1 style="margin:4px 0 0;font-size:27px">Настройки</h1>
    <div class="f" style="padding:16px;gap:14px">
      <div class="av" style="width:54px;height:54px">${esc((me.handle[0] || '?').toUpperCase())}</div>
      <div><b>Мой адрес</b><div class="m" style="font-size:14px">${esc(me.address)}</div></div>
    </div>
    <button class="row" data-act="notif" role="switch" aria-checked="${S.notif}"><span>Уведомления</span><span class="sw ${S.notif ? 'on' : ''}"></span></button>
    <button class="row" data-act="readall"><span>Прочитать все письма</span></button>
    <button class="row" data-act="logout"><span style="color:#ff8b8b">Выйти из почты</span></button>
    <p class="m" style="font-size:13px;text-align:center;margin-top:auto">NEVIX MAIL · версия 1.0<br>Письма ходят между адресами @${DOMAIN}</p>
  </div>${nav('settings')}`;
}

function view() {
  let h = '';
  if (S.scr === 'boot') h = `<div class="scr" style="justify-content:center;text-align:center"><div class="logo" style="justify-content:center"><b>N</b>NEVIX MAIL</div><p class="m">Загрузка…</p></div>`;
  else if (S.scr === 'nodb') h = `<div class="scr" style="justify-content:center;text-align:center"><div class="logo" style="justify-content:center"><b>N</b>NEVIX MAIL</div><p class="m">Почта на сервере. Нужно открыть адрес сервера NEVIX MAIL, а не файл с телефона.</p></div>`;
  else if (S.scr === 'login') h = viewLogin();
  else if (S.scr === 'reg') h = viewReg();
  else if (S.scr === 'list') h = viewList();
  else if (S.scr === 'letter') h = viewLetter();
  else if (S.scr === 'compose') h = viewCompose();
  else h = viewSettings();
  app.innerHTML = h;
  if (S.scr === 'list') loadList();
  if (S.scr === 'compose') setTimeout(() => { const el = $('#body'); if (el && !(S.draft && S.draft.body)) $('#to').focus(); }, 60);
}

/* ─────────── список писем ─────────── */
function itemHtml(m) {
  return `<button class="item" data-open="${esc(m.id)}">
    <div class="av">${esc((m.who || '?')[0]).toUpperCase()}</div>
    <div class="it">
      <div class="t">${esc(m.who)}<span>${fmt(m.ts)}</span></div>
      <div class="s">${esc(m.subj || '(без темы)')}</div>
      <div class="p">${esc(m.preview)}</div>
    </div>${m.unread ? '<i class="dot" aria-label="Новое"></i>' : ''}
  </button>`;
}

async function loadList() {
  const q = S.q;
  try {
    const d = await api('/api/mail?box=' + encodeURIComponent(S.box) + '&q=' + encodeURIComponent(q));
    if (S.scr !== 'list') return;
    const box = $('#list');
    if (!box) return;
    const letters = d.letters || [];
    S.unread = d.unread || 0;
    const p = $('#pill');
    if (p) p.innerHTML = pillHtml();
    box.innerHTML = letters.length
      ? letters.map(itemHtml).join('')
      : `<p class="m" style="text-align:center;margin-top:34px">${q ? 'Ничего не нашлось' : 'Здесь пока пусто'}</p>`;
  } catch (e) {
    if (e.status === 401) { logoutLocal(); return; }
    const box = $('#list');
    if (box) box.innerHTML = `<p class="m" style="text-align:center;margin-top:30px">Не получилось загрузить. Проверьте интернет.</p>`;
  }
}

/* ─────────── действия ─────────── */
async function doLogin() {
  const err = $('#err');
  const handle = ($('#h').value || '').trim().toLowerCase();
  const pass = $('#pw').value;
  if (!handle) { err.textContent = 'Напишите адрес'; return; }
  if (!pass) { err.textContent = 'Напишите пароль'; return; }
  err.textContent = '';
  try {
    const d = await api('/api/auth/login', { method: 'POST', body: { handle, password: pass } });
    afterAuth(d);
  } catch (e) { err.textContent = e.message; }
}

async function doRegister() {
  const err = $('#err');
  const handle = ($('#h').value || '').trim().toLowerCase();
  const pass = $('#pw').value;
  const pass2 = $('#pw2').value;
  err.textContent = '';
  if (!/^[a-z0-9._-]{3,20}$/.test(handle)) { err.textContent = 'Адрес: 3–20 символов, латиница, цифры, точка, дефис'; return; }
  if (pass.length < 6) { err.textContent = 'Пароль должен быть не короче 6 символов'; return; }
  if (pass !== pass2) { $('#pw').value = ''; $('#pw2').value = ''; $('#pw').focus(); err.textContent = 'Пароли не совпали. Введите заново'; return; }
  try {
    const d = await api('/api/auth/register', { method: 'POST', body: { handle, password: pass } });
    afterAuth(d);
    say('Адрес создан');
  } catch (e) { err.textContent = e.message; }
}

async function doNevixLogin() {
  const err = $('#err');
  err.textContent = '';
  const nevixName = ($('#nh').value || '').trim();
  const nevixPassword = $('#np').value;
  if (!nevixName || !nevixPassword) { err.textContent = 'Напишите имя и пароль от мессенджера'; return; }
  try {
    const d = await api('/api/auth/nevix-pass', { method: 'POST', body: { nevixName, nevixPassword } });
    S.nevixForm = false;
    afterAuth(d);
    say('Вошли через NEVIX');
  } catch (e) { err.textContent = e.message; }
}

function afterAuth(d) {
  S.token = d.token;
  S.me = d.user;
  localStorage.setItem('nevixmail.token', S.token);
  S.scr = 'list';
  S.box = 'inbox';
  view();
}

function logoutLocal() {
  S.token = '';
  S.me = null;
  localStorage.removeItem('nevixmail.token');
  S.scr = 'login';
  view();
}

async function openLetter(id) {
  try {
    const d = await api('/api/mail/' + encodeURIComponent(id));
    S.open = d.letter;
    S.scr = 'letter';
    view();
    loadPillSoon();
  } catch (e) { say(e.message); }
}

function loadPillSoon() {
  api('/api/me').then((d) => { S.unread = d.unread || 0; }).catch(() => {});
}

async function setFlag(flag, msg) {
  try {
    await api('/api/mail/' + encodeURIComponent(S.open.id) + '/flag', { method: 'POST', body: { flag } });
    S.scr = 'list';
    S.box = 'inbox';
    view();
    say(msg);
  } catch (e) { say(e.message); }
}

function draftFromForm() {
  return {
    id: (S.draft || {}).id,
    to: ($('#to').value || '').trim(),
    subj: ($('#subj').value || '').trim(),
    body: $('#body').value
  };
}

async function saveDraft(silent) {
  const d = draftFromForm();
  if (!d.to && !d.subj && !d.body.trim()) return null;
  try {
    const r = await api('/api/drafts', { method: 'POST', body: d });
    if (S.draft) S.draft.id = r.id;
    if (!silent) say('Сохранено в черновики');
    return r.id;
  } catch (e) {
    if (!silent) say(e.message);
    return null;
  }
}

async function doSend() {
  const err = $('#err');
  const d = draftFromForm();
  err.textContent = '';
  if (!d.to) { err.textContent = 'Укажите получателя'; return; }
  if (!d.body.trim() && !d.subj) { err.textContent = 'Письмо пустое'; return; }
  const btn = document.querySelector('[data-act="send"]');
  if (btn) btn.disabled = true;
  try {
    await api('/api/mail', { method: 'POST', body: { to: d.to, subj: d.subj, body: d.body, draftId: d.id } });
    S.draft = null;
    S.box = 'sent';
    S.scr = 'list';
    view();
    say('Письмо отправлено');
  } catch (e) {
    if (btn) btn.disabled = false;
    err.textContent = e.message;
  }
}

/* ─────────── клики ─────────── */
app.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-go],[data-open],[data-act],[data-box]');
  if (!t) return;

  if (t.dataset.go) {
    const k = t.dataset.go;
    if (k === 'compose') {
      S.draft = { id: null, to: '', subj: '', body: '' };
      S.scr = 'compose';
      return view();
    }
    if (k === 'list') { S.q = ''; }
    S.scr = k;
    return view();
  }

  if (t.dataset.box) { S.box = t.dataset.box; S.q = ''; return view(); }

  if (t.dataset.open) {
    if (S.box === 'drafts') {
      try {
        const d = await api('/api/drafts/' + encodeURIComponent(t.dataset.open));
        S.draft = d.draft;
        S.scr = 'compose';
        return view();
      } catch (er) { return say(er.message); }
    }
    return openLetter(t.dataset.open);
  }

  const a = t.dataset.act;
  if (a === 'login') return doLogin();
  if (a === 'nevixtoggle') { S.nevixForm = !S.nevixForm; return view(); }
  if (a === 'nevixlogin') return doNevixLogin();
  if (a === 'register') return doRegister();
  if (a === 'toreg') { S.scr = 'reg'; return view(); }
  if (a === 'tologin') { S.scr = 'login'; return view(); }
  if (a === 'send') return doSend();
  if (a === 'cancel') {
    const d = draftFromForm();
    if (d.to || d.subj || d.body.trim()) { await saveDraft(true); S.box = 'drafts'; }
    S.draft = null;
    S.scr = 'list';
    return view();
  }
  if (a === 'reply') {
    const m = S.open;
    S.draft = { id: null, to: m.from, subj: 'Re: ' + (m.subj || ''), body: '' };
    S.scr = 'compose';
    return view();
  }
  if (a === 'trash') return setFlag('trash', 'Перемещено в корзину');
  if (a === 'spam') return setFlag('spam', 'Отмечено как спам');
  if (a === 'restore') return setFlag(null, 'Письмо возвращено');
  if (a === 'gone') {
    try {
      await api('/api/mail/' + encodeURIComponent(S.open.id), { method: 'DELETE' });
      S.scr = 'list';
      view();
      say('Удалено навсегда');
    } catch (er) { say(er.message); }
    return;
  }
  if (a === 'notif') {
    S.notif = !S.notif;
    localStorage.setItem('nevixmail.notif', S.notif ? '1' : '0');
    return view();
  }
  if (a === 'readall') {
    try { await api('/api/mail/readall', { method: 'POST' }); say('Все письма прочитаны'); } catch (er) { say(er.message); }
    return;
  }
  if (a === 'logout') {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (er) {}
    return logoutLocal();
  }
});

app.addEventListener('input', (e) => {
  if (e.target.id === 'q') {
    S.q = e.target.value;
    clearTimeout(window.__qt);
    window.__qt = setTimeout(loadList, 220);
  }
});

/* ─────────── старт ─────────── */
async function boot() {
  try {
    const h = await api('/api/health');
    if (!h.db) { S.scr = 'nodb'; return view(); }
    S.nevixLogin = !!h.nevixLogin;
    if (S.token) {
      try {
        const d = await api('/api/me');
        S.me = d.user;
        S.unread = d.unread || 0;
        S.scr = 'list';
        return view();
      } catch (e) {
        if (e.status === 401) { S.token = ''; localStorage.removeItem('nevixmail.token'); }
      }
    }
    S.scr = 'login';
    view();
  } catch (e) {
    S.scr = 'nodb';
    view();
  }
}

{
  window.__MAIL__ = {
    state: () => ({ scr: S.scr, box: S.box, unread: S.unread, me: S.me, letters: document.querySelectorAll('.item').length }),
    setToken: (t) => { S.token = t; localStorage.setItem('nevixmail.token', t); },
    go: (k) => { S.scr = k; view(); }
  };
}

boot();
