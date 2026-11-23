/**
 * NEVIX MAIL — сервер (короткая версия, чтобы точно влезла при копировании)
 * Адреса @nevixmail.com, вход по адресу/паролю или аккаунту мессенджера NEVIX,
 * письма внутри Nevix, папки, поиск.
 * Переменные на Render: DATABASE_URL (база из Neon), NEVIX_CHAT_URL (для входа через мессенджер).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const D = 'nevixmail.com';
const CHAT = (process.env.NEVIX_CHAT_URL || '').replace(/\/+$/, '');
const MEM = String(process.env.PG_MEM || '') === '1';
const RESEND = String(process.env.RESEND_KEY || '').trim();         // ключ Resend — почта наружу
const RESEND_URL = (process.env.RESEND_BASE || 'https://api.resend.com').replace(/\/+$/, '');
const BREVO = String(process.env.BREVO_KEY || '').trim();          // ключ Brevo (запасной путь)
const BREVO_URL = (process.env.BREVO_BASE || 'https://api.brevo.com').replace(/\/+$/, '');
const FROM = String(process.env.MAIL_FROM || '').trim();           // адрес отправителя
const FROM_NAME = String(process.env.MAIL_FROM_NAME || 'NEVIX Mail');
const OUT_KIND = RESEND ? 'resend' : (BREVO ? 'brevo' : '');
const OUT_READY = !!(OUT_KIND && FROM);

/* ── мелкие помощники ── */
const nid = (p) => p + '_' + crypto.randomBytes(9).toString('hex');
const ntok = () => crypto.randomBytes(24).toString('hex');
const HRE = /^[a-z0-9._-]{3,20}$/;
const ERE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const cl = (v) => String(v || '').trim().toLowerCase().replace('@' + D, '');

/* имя на русском → ник латиницей (Игорь → igor) */
const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',
  м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',
  ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function nickFrom(name) {
  const a = String(name || '').toLowerCase().split('');
  let out = '';
  for (const ch of a) out += (TR[ch] !== undefined ? TR[ch] : ch);
  out = out.replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 20);
  return out;
}

function hp(p) {
  const s = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(p), s, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + s.toString('hex') + '$' + h.toString('hex');
}
function cp(p, st) {
  try {
    const [k, s, h] = String(st).split('$');
    if (k !== 'scrypt') return false;
    const sb = Buffer.from(s, 'hex');
    const hb = Buffer.from(h, 'hex');
    return crypto.timingSafeEqual(hb, crypto.scryptSync(String(p), sb, hb.length, { N: 16384, r: 8, p: 1 }));
  } catch (e) { return false; }
}
function js(res, code, o) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(o));
}
function rb(req) {
  return new Promise((ok, no) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 200000) { no(new Error('big')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      const t = Buffer.concat(parts).toString('utf8');
      if (!t) return ok({});
      try { ok(JSON.parse(t)); } catch (e) { no(new Error('json')); }
    });
    req.on('error', no);
  });
}

const SCHEMA = [
  `create table if not exists nx_mail_users (id text primary key, handle text not null unique,
     pass text not null default '', via text not null default 'pass', nevix_id text,
     created timestamptz not null default now())`,
  `create table if not exists nx_mail_tokens (token text primary key, user_id text not null,
     created timestamptz not null default now())`,
  `create table if not exists nx_mail_letters (id text primary key, from_h text not null,
     to_h text not null, subj text not null default '', body text not null default '',
     created timestamptz not null default now())`,
  `create table if not exists nx_mail_flags (letter_id text not null, user_id text not null,
     flag text not null, primary key (letter_id, user_id))`,
  `create table if not exists nx_mail_reads (letter_id text not null, user_id text not null,
     primary key (letter_id, user_id))`,
  `create table if not exists nx_mail_drafts (id text primary key, user_id text not null,
     to_h text not null default '', subj text not null default '', body text not null default '',
     updated timestamptz not null default now())`,
  `create index if not exists nx_mail_letters_to on nx_mail_letters (to_h)`,
  `create index if not exists nx_mail_letters_from on nx_mail_letters (from_h)`
];

let pool = null;

async function makePool() {
  const { Pool } = require('pg');
  if (MEM) {
    const { newDb } = require('pg-mem');
    const pg = newDb().adapters.createPg();
    return new pg.Pool();
  }
  if (!process.env.DATABASE_URL) return null;
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 5
  });
}

/* ── вход ── */
function userJson(u) {
  return { handle: u.handle, address: u.handle + '@' + D, via: u.via };
}

async function authUser(req) {
  const h = String(req.headers.authorization || '');
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!t) return null;
  const r = await getPool().query('select u.* from nx_mail_tokens t join nx_mail_users u on u.id = t.user_id where t.token = $1', [t]);
  return r.rows[0] || null;
}

async function whoInNevix(token) {
  if (!CHAT || !token) return null;
  try {
    const r = await fetch(CHAT + '/api/me', { headers: { authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const d = await r.json();
    const u = d.user || d;
    if (!u || !u.id) return null;
    return { id: String(u.id), handle: cl(u.username || ''), name: String(u.name || '') };
  } catch (e) {
    console.log('[mail] мессенджер не ответил: ' + e.message);
    return null;
  }
}

async function userForNevix(who) {
  let r = await getPool().query('select * from nx_mail_users where nevix_id = $1', [who.id]);
  let u = r.rows[0];
  if (!u && who.handle) {
    r = await getPool().query('select * from nx_mail_users where handle = $1', [who.handle]);
    u = r.rows[0];
    if (u && !u.nevix_id) await getPool().query('update nx_mail_users set nevix_id = $1 where id = $2', [who.id, u.id]);
  }
  if (u) return u;
  /* ника может не быть — тогда берём имя (Игорь → igor), иначе номер аккаунта */
  let handle = '';
  if (who.handle && HRE.test(who.handle)) {
    handle = who.handle;
  } else {
    const fromName = nickFrom(who.name || who.handle || '');
    if (fromName.length >= 3 && HRE.test(fromName)) handle = fromName;
  }
  if (!handle) handle = 'user' + String(who.id).replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
  if (!HRE.test(handle)) handle = 'user' + crypto.randomBytes(3).toString('hex');
  const busy = await getPool().query('select 1 from nx_mail_users where handle = $1', [handle]);
  if (busy.rowCount) handle = handle.slice(0, 12) + crypto.randomBytes(2).toString('hex');
  const id = nid('u');
  await getPool().query('insert into nx_mail_users (id, handle, pass, via, nevix_id) values ($1,$2,$3,$4,$5)',
    [id, handle, '', 'nevix', who.id]);
  r = await getPool().query('select * from nx_mail_users where id = $1', [id]);
  return r.rows[0];
}

async function giveToken(res, u, code) {
  const token = ntok();
  await getPool().query('insert into nx_mail_tokens (token, user_id) values ($1,$2)', [token, u.id]);
  return js(res, code, { token, user: userJson(u) });
}

/* ── отправка наружу (gmail и другие) ── */
const outCount = new Map();

function outLimit(handle) {
  const now = Date.now();
  const row = outCount.get(handle) || { n: 0, t: now };
  if (now - row.t > 3600000) { row.n = 0; row.t = now; }
  if (row.n >= 30) return false;
  row.n++;
  outCount.set(handle, row);
  return true;
}

async function sendOutside(to, subj, body) {
  if (!OUT_READY) {
    const e = new Error('Отправка на другие адреса ещё не настроена. Пока письма ходят только между адресами Nevix.');
    e.code = 'NOOUT';
    throw e;
  }
  const safe = String(body).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = '<div style="font-family:sans-serif;font-size:16px;white-space:pre-wrap">' + safe + '</div>';

  const req = OUT_KIND === 'resend'
    ? {
        url: RESEND_URL + '/emails',
        headers: { authorization: 'Bearer ' + RESEND, 'content-type': 'application/json' },
        body: { from: FROM_NAME + ' <' + FROM + '>', to: [to], subject: subj || '(без темы)', text: body, html }
      }
    : {
        url: BREVO_URL + '/v3/smtp/email',
        headers: { 'api-key': BREVO, 'content-type': 'application/json' },
        body: {
          sender: { name: FROM_NAME, email: FROM },
          to: [{ email: to }],
          subject: subj || '(без темы)',
          textContent: body,
          htmlContent: html
        }
      };

  const r = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  if (!r.ok) {
    let msg = '';
    try {
      const d = await r.json();
      msg = d.message || d.error || (d.errors && d.errors[0] && d.errors[0].message) || '';
    } catch (e) {}
    const err = new Error(
      'Почтовый сервис не принял письмо' + (msg ? ': ' + msg : ' (код ' + r.status + ')') +
      (r.status === 403 ? '. Пока свой домен не подключён, отправлять можно только на свою почту.' : '')
    );
    err.code = 'OUT' + r.status;
    throw err;
  }
  return true;
}

/* ── папки ── */
function boxSql(box) {
  if (box === 'sent') return 'l.from_h = $1 and f.flag is null';
  if (box === 'trash') return "(l.from_h = $1 or l.to_h = $1) and f.flag = 'trash'";
  if (box === 'spam') return "l.to_h = $1 and f.flag = 'spam'";
  return 'l.to_h = $1 and f.flag is null';
}



/* ── добавочные адреса: тема, пароль, чёрный список, «прочитано» ──
   Вынесено сюда, чтобы при загрузке на GitHub было меньше файлов. */


let booted = null;
function ensure() {
  if (booted) return booted;
  booted = (async () => {
    await getPool().query(
      `create table if not exists nx_mail_prefs (user_id text primary key,
         theme text not null default 'dark')`);
    await getPool().query(
      `create table if not exists nx_mail_blocks (user_id text not null, addr text not null,
         created timestamptz not null default now(), primary key (user_id, addr))`);
  })().catch((e) => { booted = null; throw e; });
  return booted;
}

const MINE = (p) =>
  p === '/api/prefs' || p === '/api/password' || p === '/api/blocks' ||
  p.startsWith('/api/blocks/') || /^\/api\/mail\/[^/]+\/read$/.test(p);

async function blocksOf(userId) {
  const r = await getPool().query('select addr from nx_mail_blocks where user_id = $1 order by addr', [userId]);
  return r.rows.map((x) => x.addr);
}

async function tryRoute(req, res, url) {
  const p = url.pathname;
  if (!MINE(p)) return false;

  try { await ensure(); }
  catch (e) {
    js(res, 500, { error: 'База не готова: ' + String(e.message || e).slice(0, 80) });
    return true;
  }

  const me = await authUser(req);
  if (!me) { js(res, 401, { error: 'Нужно войти' }); return true; }

  /* тема оформления */
  if (p === '/api/prefs') {
    if (req.method === 'GET') {
      const r = await getPool().query('select theme from nx_mail_prefs where user_id = $1', [me.id]);
      return js(res, 200, {
        theme: (r.rows[0] || {}).theme || 'dark',
        blocks: await blocksOf(me.id)
      }), true;
    }
    if (req.method === 'POST') {
      const b = await rb(req);
      const theme = b.theme === 'light' ? 'light' : 'dark';
      await getPool().query(
        `insert into nx_mail_prefs (user_id, theme) values ($1,$2)
         on conflict (user_id) do update set theme = $2`, [me.id, theme]);
      js(res, 200, { ok: true, theme });
      return true;
    }
  }

  /* смена пароля */
  if (p === '/api/password' && req.method === 'POST') {
    const b = await rb(req);
    const oldPass = String(b.old || '');
    const pass = String(b.new || '');
    if (pass.length < 6) { js(res, 400, { error: 'Новый пароль от 6 символов' }); return true; }
    if (me.via === 'nevix') {
      js(res, 400, { error: 'Этот адрес входит через мессенджер NEVIX — пароль там и меняется' });
      return true;
    }
    if (!me.pass || !cp(oldPass, me.pass)) { js(res, 403, { error: 'Старый пароль не подошёл' }); return true; }
    await getPool().query('update nx_mail_users set pass = $1, via = $2 where id = $3', [hp(pass), 'pass', me.id]);
    /* остальные устройства выходят, текущее остаётся */
    const h = String(req.headers.authorization || '');
    const now = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    await getPool().query('delete from nx_mail_tokens where user_id = $1 and token <> $2', [me.id, now]);
    js(res, 200, { ok: true });
    return true;
  }

  /* чёрный список */
  if (p === '/api/blocks') {
    if (req.method === 'GET') {
      js(res, 200, { blocks: await blocksOf(me.id) });
      return true;
    }
    if (req.method === 'POST') {
      const b = await rb(req);
      const raw = String(b.addr || '').trim().toLowerCase();
      if (!raw) { js(res, 400, { error: 'Напишите адрес' }); return true; }
      const addr = raw.includes('@') ? raw : cl(raw) + '@' + D;
      const local = addr.endsWith('@' + D) ? addr.slice(0, -(D.length + 1)) : '';
      const okLocal = local && HRE.test(local);
      if (!okLocal && !ERE.test(addr)) { js(res, 400, { error: 'Проверьте адрес' }); return true; }
      if (addr === me.handle + '@' + D) { js(res, 400, { error: 'Свой адрес блокировать не нужно' }); return true; }
      await getPool().query(
        'insert into nx_mail_blocks (user_id, addr) values ($1,$2) on conflict do nothing', [me.id, addr]);
      js(res, 200, { ok: true, addr, blocks: await blocksOf(me.id) });
      return true;
    }
  }

  const mBlock = p.match(/^\/api\/blocks\/([^/]+)$/);
  if (mBlock && req.method === 'DELETE') {
    const addr = decodeURIComponent(mBlock[1]).toLowerCase();
    await getPool().query('delete from nx_mail_blocks where user_id = $1 and addr = $2', [me.id, addr]);
    js(res, 200, { ok: true, blocks: await blocksOf(me.id) });
    return true;
  }

  /* отметить письмо прочитанным (свайп вправо) */
  const mRead = p.match(/^\/api\/mail\/([^/]+)\/read$/);
  if (mRead && req.method === 'POST') {
    const id = decodeURIComponent(mRead[1]);
    const r = await getPool().query('select from_h, to_h from nx_mail_letters where id = $1', [id]);
    const l = r.rows[0];
    if (!l) { js(res, 404, { error: 'Письмо не найдено' }); return true; }
    if (l.to_h !== me.handle) { js(res, 403, { error: 'Это не входящее письмо' }); return true; }
    await getPool().query('insert into nx_mail_reads (letter_id, user_id) values ($1,$2) on conflict do nothing', [id, me.id]);
    js(res, 200, { ok: true });
    return true;
  }

  js(res, 404, { error: 'Нет такого адреса' });
  return true;
}


function getPool() {
  if (!pool) throw new Error('база не подключена');
  return pool;
}

function setPool(p) { pool = p; }

module.exports = {
  http, fs, path, crypto, URL, PORT, ROOT, D, CHAT, MEM, getPool, setPool, makePool,
  RESEND, RESEND_URL, BREVO, BREVO_URL, FROM, FROM_NAME, OUT_KIND, OUT_READY,
  nid, ntok, HRE, ERE, cl, nickFrom, hp, cp, js, rb, SCHEMA,
  userJson, authUser, whoInNevix, userForNevix, giveToken, boxSql, tryRoute
};
