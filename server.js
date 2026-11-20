/**
 * NEVIX MAIL — сервер
 * Что делает: адреса @nevixmail.com, вход (адрес+пароль или аккаунт мессенджера NEVIX),
 * письма внутри Nevix, папки, поиск.
 *
 * Переменные окружения (задаются на Render, не в коде):
 *   DATABASE_URL   — строка postgresql:// из Neon
 *   NEVIX_CHAT_URL — адрес мессенджера для входа тем же аккаунтом (необязательно)
 *   PORT           — порт (Render даёт сам)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const MAIL_DOMAIN = 'nevixmail.com';
const NEVIX_CHAT_URL = (process.env.NEVIX_CHAT_URL || '').replace(/\/+$/, '');
const USE_MEM = String(process.env.PG_MEM || '') === '1';

/* ─────────── утилиты ─────────── */
const newId = (p) => p + '_' + crypto.randomBytes(9).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');

function hashPass(pass) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pass), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function checkPass(pass, stored) {
  try {
    const [kind, saltHex, hashHex] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const hash = Buffer.from(hashHex, 'hex');
    const test = crypto.scryptSync(String(pass), salt, hash.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(hash, test);
  } catch (e) { return false; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

/* ─────────── схема ─────────── */
const SCHEMA = [
  `create table if not exists mail_users (
     id text primary key,
     handle text not null unique,
     pass text not null default '',
     via text not null default 'pass',
     nevix_id text,
     created timestamptz not null default now()
   )`,
  `create table if not exists mail_tokens (
     token text primary key,
     user_id text not null,
     created timestamptz not null default now()
   )`,
  `create table if not exists mail_letters (
     id text primary key,
     from_h text not null,
     to_h text not null,
     subj text not null default '',
     body text not null default '',
     created timestamptz not null default now()
   )`,
  `create table if not exists mail_flags (
     letter_id text not null,
     user_id text not null,
     flag text not null,
     primary key (letter_id, user_id)
   )`,
  `create table if not exists mail_reads (
     letter_id text not null,
     user_id text not null,
     primary key (letter_id, user_id)
   )`,
  `create table if not exists mail_drafts (
     id text primary key,
     user_id text not null,
     to_h text not null default '',
     subj text not null default '',
     body text not null default '',
     updated timestamptz not null default now()
   )`,
  `create index if not exists mail_letters_to on mail_letters (to_h)`,
  `create index if not exists mail_letters_from on mail_letters (from_h)`
];

/* ─────────── база ─────────── */
let pool = null;

async function makePool() {
  const { Pool } = require('pg');
  if (USE_MEM) {
    const { newDb } = require('pg-mem');
    const db = newDb();
    const pg = db.adapters.createPg();
    console.log('[mail] тестовая база в памяти (PG_MEM=1)');
    return new pg.Pool();
  }
  if (!process.env.DATABASE_URL) {
    console.log('[mail] нет DATABASE_URL — база выключена, работать нельзя');
    return null;
  }
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 5
  });
}

async function ensureSchema(p) {
  for (const sql of SCHEMA) await p.query(sql);
}

/* ─────────── проверки ─────────── */
const HANDLE_RE = /^[a-z0-9._-]{3,20}$/;
const cleanHandle = (v) => String(v || '').trim().toLowerCase().replace('@' + MAIL_DOMAIN, '');

function userJson(u) {
  return { handle: u.handle, address: u.handle + '@' + MAIL_DOMAIN, via: u.via };
}

async function authUser(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const r = await pool.query(
    'select u.* from mail_tokens t join mail_users u on u.id = t.user_id where t.token = $1',
    [token]
  );
  return r.rows[0] || null;
}

/* ─────────── кто я в мессенджере NEVIX ─────────── */
async function whoAmIInNevix(nevixToken) {
  if (!NEVIX_CHAT_URL || !nevixToken) return null;
  try {
    const r = await fetch(NEVIX_CHAT_URL + '/api/me', {
      headers: { authorization: 'Bearer ' + nevixToken }
    });
    if (!r.ok) return null;
    const d = await r.json();
    const u = d.user || d;
    if (!u || !u.id) return null;
    return { id: String(u.id), handle: cleanHandle(u.username || '') };
  } catch (e) {
    console.log('[mail] мессенджер не ответил: ' + e.message);
    return null;
  }
}

/* найти или создать почтовый адрес для аккаунта мессенджера */
async function userForNevix(who) {
  let r = await pool.query('select * from mail_users where nevix_id = $1', [who.id]);
  let u = r.rows[0];
  if (!u && who.handle) {
    r = await pool.query('select * from mail_users where handle = $1', [who.handle]);
    u = r.rows[0];
    if (u && !u.nevix_id) await pool.query('update mail_users set nevix_id = $1 where id = $2', [who.id, u.id]);
  }
  if (u) return u;
  let handle = who.handle;
  if (!HANDLE_RE.test(handle)) handle = 'user' + String(who.id).replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
  const taken = await pool.query('select 1 from mail_users where handle = $1', [handle]);
  if (taken.rowCount) handle = handle.slice(0, 12) + crypto.randomBytes(2).toString('hex');
  const id = newId('u');
  await pool.query('insert into mail_users (id, handle, pass, via, nevix_id) values ($1,$2,$3,$4,$5)',
    [id, handle, '', 'nevix', who.id]);
  r = await pool.query('select * from mail_users where id = $1', [id]);
  return r.rows[0];
}

/* ─────────── папки ─────────── */
function boxWhere(box, handle) {
  switch (box) {
    case 'sent':
      return { sql: 'l.from_h = $1 and f.flag is null', params: [handle] };
    case 'trash':
      return { sql: "l.from_h = $1 and f.flag = 'trash'", params: [handle] };
    case 'spam':
      return { sql: "l.to_h = $1 and f.flag = 'spam'", params: [handle] };
    default:
      return { sql: 'l.to_h = $1 and f.flag is null', params: [handle] };
  }
}

/* ─────────── сервер ─────────── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    /* статика */
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const full = path.join(ROOT, file);
      if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('нет такой страницы');
      }
      const ext = path.extname(full);
      const types = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
      };
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
      return fs.createReadStream(full).pipe(res);
    }

    if (p === '/api/health') {
      return json(res, 200, {
        ok: true, db: !!pool, domain: MAIL_DOMAIN,
        nevixLogin: !!NEVIX_CHAT_URL, time: new Date().toISOString()
      });
    }

    if (!pool) return json(res, 503, { error: 'База не подключена. Добавьте DATABASE_URL на сервере.' });

    /* ── регистрация: адрес + пароль ── */
    if (p === '/api/auth/register' && req.method === 'POST') {
      const b = await readBody(req);
      const handle = cleanHandle(b.handle);
      const pass = String(b.password || '');
      if (!HANDLE_RE.test(handle)) return json(res, 400, { error: 'Адрес: 3–20 символов, латиница, цифры, точка, дефис' });
      if (pass.length < 6) return json(res, 400, { error: 'Пароль от 6 символов' });
      const busy = await pool.query('select 1 from mail_users where handle = $1', [handle]);
      if (busy.rowCount) return json(res, 409, { error: 'Этот адрес уже занят' });
      const id = newId('u');
      await pool.query('insert into mail_users (id, handle, pass, via) values ($1,$2,$3,$4)', [id, handle, hashPass(pass), 'pass']);
      const token = newToken();
      await pool.query('insert into mail_tokens (token, user_id) values ($1,$2)', [token, id]);
      return json(res, 201, { token, user: { handle, address: handle + '@' + MAIL_DOMAIN, via: 'pass' } });
    }

    /* ── вход: адрес + пароль ── */
    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody(req);
      const handle = cleanHandle(b.handle);
      const r = await pool.query('select * from mail_users where handle = $1', [handle]);
      const u = r.rows[0];
      if (!u || !u.pass || !checkPass(String(b.password || ''), u.pass)) {
        return json(res, 401, { error: 'Неверный адрес или пароль' });
      }
      const token = newToken();
      await pool.query('insert into mail_tokens (token, user_id) values ($1,$2)', [token, u.id]);
      return json(res, 200, { token, user: userJson(u) });
    }

    /* ── вход по имени и паролю от мессенджера ── */
    if (p === '/api/auth/nevix-pass' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.nevixName || '').trim();
      const pass = String(b.nevixPassword || '');
      if (!name || !pass) return json(res, 400, { error: 'Напишите имя и пароль от мессенджера' });
      if (!NEVIX_CHAT_URL) return json(res, 501, { error: 'Вход через мессенджер не настроен на сервере' });
      let chatToken = '';
      try {
        const r = await fetch(NEVIX_CHAT_URL + '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, password: pass })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.token) return json(res, 401, { error: d.error || 'Мессенджер не принял имя или пароль' });
        chatToken = d.token;
      } catch (e) {
        return json(res, 502, { error: 'Мессенджер не отвечает. Попробуйте позже' });
      }
      const who = await whoAmIInNevix(chatToken);
      if (!who) return json(res, 401, { error: 'Не получилось подтвердить аккаунт мессенджера' });
      const u = await userForNevix(who);
      const token = newToken();
      await pool.query('insert into mail_tokens (token, user_id) values ($1,$2)', [token, u.id]);
      return json(res, 200, { token, user: userJson(u) });
    }

    /* ── вход по токену мессенджера (если уже вошёл там) ── */
    if (p === '/api/auth/nevix' && req.method === 'POST') {
      const b = await readBody(req);
      const who = await whoAmIInNevix(String(b.nevixToken || ''));
      if (!who) return json(res, 401, { error: 'Мессенджер не подтвердил аккаунт' });
      const u = await userForNevix(who);
      const token = newToken();
      await pool.query('insert into mail_tokens (token, user_id) values ($1,$2)', [token, u.id]);
      return json(res, 200, { token, user: userJson(u) });
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const h = String(req.headers.authorization || '');
      const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      if (token) await pool.query('delete from mail_tokens where token = $1', [token]);
      return json(res, 200, { ok: true });
    }

    /* ── дальше всё требует входа ── */
    const me = await authUser(req);
    if (!me) return json(res, 401, { error: 'Нужно войти' });

    if (p === '/api/me' && req.method === 'GET') {
      const un = await pool.query(
        `select count(*)::int as n from mail_letters l
         left join mail_flags f on f.letter_id = l.id and f.user_id = $2
         left join mail_reads r on r.letter_id = l.id and r.user_id = $2
         where l.to_h = $1 and f.flag is null and r.letter_id is null`,
        [me.handle, me.id]
      );
      return json(res, 200, { user: userJson(me), unread: un.rows[0].n });
    }

    /* ── есть ли такой адрес ── */
    if (p === '/api/lookup' && req.method === 'GET') {
      const handle = cleanHandle(url.searchParams.get('handle'));
      if (!HANDLE_RE.test(handle)) return json(res, 200, { exists: false });
      const r = await pool.query('select handle from mail_users where handle = $1', [handle]);
      return json(res, 200, { exists: r.rowCount > 0, handle });
    }

    /* ── список писем папки ── */
    if (p === '/api/mail' && req.method === 'GET') {
      const box = String(url.searchParams.get('box') || 'inbox');
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();

      if (box === 'drafts') {
        const r = await pool.query(
          'select id, to_h, subj, body, updated from mail_drafts where user_id = $1 order by updated desc',
          [me.id]
        );
        let list = r.rows.map((d) => ({
          id: d.id, who: d.to_h || 'Без адреса', subj: d.subj, preview: d.body, ts: d.updated, unread: false
        }));
        if (q) list = list.filter((x) => (x.who + x.subj + x.preview).toLowerCase().includes(q));
        return json(res, 200, { box, letters: list, unread: 0 });
      }

      const w = boxWhere(box, me.handle);
      const r = await pool.query(
        `select l.*, (r.letter_id is not null) as is_read
         from mail_letters l
         left join mail_flags f on f.letter_id = l.id and f.user_id = $2
         left join mail_reads r on r.letter_id = l.id and r.user_id = $2
         where ${w.sql}
         order by l.created desc
         limit 300`,
        [w.params[0], me.id]
      );
      let list = r.rows.map((l) => {
        const outgoing = l.from_h === me.handle;
        return {
          id: l.id, who: outgoing ? l.to_h : l.from_h, outgoing,
          subj: l.subj, preview: l.body, ts: l.created,
          unread: box === 'inbox' && !l.is_read
        };
      });
      if (q) list = list.filter((x) => (x.who + x.subj + x.preview).toLowerCase().includes(q));
      const unread = list.filter((x) => x.unread).length;
      return json(res, 200, { box, letters: list, unread });
    }

    /* ── прочитать все ── */
    if (p === '/api/mail/readall' && req.method === 'POST') {
      await pool.query(
        `insert into mail_reads (letter_id, user_id)
         select l.id, $2 from mail_letters l
         left join mail_flags f on f.letter_id = l.id and f.user_id = $2
         where l.to_h = $1 and f.flag is null
         on conflict do nothing`,
        [me.handle, me.id]
      );
      return json(res, 200, { ok: true });
    }

    /* ── отправить ── */
    if (p === '/api/mail' && req.method === 'POST') {
      const b = await readBody(req);
      const to = cleanHandle(b.to);
      const subj = String(b.subj || '').slice(0, 200);
      const body = String(b.body || '').slice(0, 20000);
      if (!HANDLE_RE.test(to)) return json(res, 400, { error: 'Укажите адрес получателя', field: 'to' });
      if (to === me.handle) return json(res, 400, { error: 'Нельзя отправить самому себе', field: 'to' });
      if (!body.trim() && !subj.trim()) return json(res, 400, { error: 'Письмо пустое', field: 'body' });
      const who = await pool.query('select 1 from mail_users where handle = $1', [to]);
      if (!who.rowCount) {
        return json(res, 404, {
          error: 'Адреса ' + to + '@' + MAIL_DOMAIN + ' нет. Пока письма ходят только между адресами Nevix.',
          field: 'to'
        });
      }
      const id = newId('m');
      await pool.query('insert into mail_letters (id, from_h, to_h, subj, body) values ($1,$2,$3,$4,$5)',
        [id, me.handle, to, subj, body]);
      if (b.draftId) await pool.query('delete from mail_drafts where id = $1 and user_id = $2', [String(b.draftId), me.id]);
      return json(res, 201, { id, ok: true });
    }

    /* ── одно письмо ── */
    if (/^\/api\/mail\/[^/]+$/.test(p) && req.method === 'GET') {
      const id = decodeURIComponent(p.split('/')[3]);
      const r = await pool.query('select * from mail_letters where id = $1', [id]);
      const l = r.rows[0];
      if (!l) return json(res, 404, { error: 'Письмо не найдено' });
      if (l.from_h !== me.handle && l.to_h !== me.handle) return json(res, 403, { error: 'Это не ваше письмо' });
      const fl = await pool.query('select flag from mail_flags where letter_id = $1 and user_id = $2', [id, me.id]);
      await pool.query('insert into mail_reads (letter_id, user_id) values ($1,$2) on conflict do nothing', [id, me.id]);
      return json(res, 200, {
        letter: {
          id: l.id, from: l.from_h, to: l.to_h, outgoing: l.from_h === me.handle,
          subj: l.subj, body: l.body, ts: l.created, flag: (fl.rows[0] || {}).flag || null
        }
      });
    }

    /* ── папка/флаг письма ── */
    if (/^\/api\/mail\/[^/]+\/flag$/.test(p) && req.method === 'POST') {
      const id = decodeURIComponent(p.split('/')[3]);
      const b = await readBody(req);
      const flag = b.flag === null || b.flag === 'none' ? null : String(b.flag || '');
      if (flag && ['trash', 'spam'].indexOf(flag) < 0) return json(res, 400, { error: 'Неизвестная папка' });
      const r = await pool.query('select * from mail_letters where id = $1', [id]);
      const l = r.rows[0];
      if (!l) return json(res, 404, { error: 'Письмо не найдено' });
      if (l.from_h !== me.handle && l.to_h !== me.handle) return json(res, 403, { error: 'Это не ваше письмо' });
      if (flag === null) {
        await pool.query('delete from mail_flags where letter_id = $1 and user_id = $2', [id, me.id]);
      } else {
        await pool.query(
          'insert into mail_flags (letter_id, user_id, flag) values ($1,$2,$3) on conflict (letter_id, user_id) do update set flag = $3',
          [id, me.id, flag]
        );
      }
      return json(res, 200, { ok: true, flag });
    }

    /* ── удалить навсегда ── */
    if (/^\/api\/mail\/[^/]+$/.test(p) && req.method === 'DELETE') {
      const id = decodeURIComponent(p.split('/')[3]);
      const r = await pool.query('select * from mail_letters where id = $1', [id]);
      const l = r.rows[0];
      if (!l) return json(res, 404, { error: 'Письмо не найдено' });
      if (l.from_h !== me.handle && l.to_h !== me.handle) return json(res, 403, { error: 'Это не ваше письмо' });
      await pool.query('delete from mail_letters where id = $1', [id]);
      await pool.query('delete from mail_flags where letter_id = $1', [id]);
      await pool.query('delete from mail_reads where letter_id = $1', [id]);
      return json(res, 200, { ok: true });
    }

    /* ── черновики ── */
    if (p === '/api/drafts' && req.method === 'POST') {
      const b = await readBody(req);
      const to = cleanHandle(b.to);
      const subj = String(b.subj || 
