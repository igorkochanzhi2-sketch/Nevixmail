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

/* ── база ── */
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
  const r = await pool.query('select u.* from nx_mail_tokens t join nx_mail_users u on u.id = t.user_id where t.token = $1', [t]);
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
    return { id: String(u.id), handle: cl(u.username || '') };
  } catch (e) {
    console.log('[mail] мессенджер не ответил: ' + e.message);
    return null;
  }
}

async function userForNevix(who) {
  let r = await pool.query('select * from nx_mail_users where nevix_id = $1', [who.id]);
  let u = r.rows[0];
  if (!u && who.handle) {
    r = await pool.query('select * from nx_mail_users where handle = $1', [who.handle]);
    u = r.rows[0];
    if (u && !u.nevix_id) await pool.query('update nx_mail_users set nevix_id = $1 where id = $2', [who.id, u.id]);
  }
  if (u) return u;
  let handle = who.handle;
  if (!HRE.test(handle)) handle = 'user' + String(who.id).replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
  const busy = await pool.query('select 1 from nx_mail_users where handle = $1', [handle]);
  if (busy.rowCount) handle = handle.slice(0, 12) + crypto.randomBytes(2).toString('hex');
  const id = nid('u');
  await pool.query('insert into nx_mail_users (id, handle, pass, via, nevix_id) values ($1,$2,$3,$4,$5)',
    [id, handle, '', 'nevix', who.id]);
  r = await pool.query('select * from nx_mail_users where id = $1', [id]);
  return r.rows[0];
}

async function giveToken(res, u, code) {
  const token = ntok();
  await pool.query('insert into nx_mail_tokens (token, user_id) values ($1,$2)', [token, u.id]);
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
  if (box === 'trash') return "l.from_h = $1 and f.flag = 'trash'";
  if (box === 'spam') return "l.to_h = $1 and f.flag = 'spam'";
  return 'l.to_h = $1 and f.flag is null';
}

/* ── маршруты ── */
async function route(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    return js(res, 200, { ok: true, db: !!pool, domain: D, nevixLogin: !!CHAT, mailOut: OUT_READY, mailKind: OUT_KIND, time: new Date().toISOString() });
  }
  if (!pool) return js(res, 503, { error: 'База не подключена. Добавьте DATABASE_URL на сервере.' });

  /* регистрация */
  if (p === '/api/auth/register' && req.method === 'POST') {
    const b = await rb(req);
    const handle = cl(b.handle);
    const pass = String(b.password || '');
    if (!HRE.test(handle)) return js(res, 400, { error: 'Адрес: 3–20 символов, латиница, цифры, точка, дефис' });
    if (pass.length < 6) return js(res, 400, { error: 'Пароль от 6 символов' });
    const busy = await pool.query('select 1 from nx_mail_users where handle = $1', [handle]);
    if (busy.rowCount) return js(res, 409, { error: 'Этот адрес уже занят' });
    const id = nid('u');
    try {
      await pool.query('insert into nx_mail_users (id, handle, pass, via) values ($1,$2,$3,$4)',
        [id, handle, hp(pass), 'pass']);
    } catch (e) {
      // гонка: кто-то успел занять этот же адрес
      if (e && (e.code === '23505' || /duplicate|unique/i.test(String(e.message)))) {
        return js(res, 409, { error: 'Этот адрес уже занят' });
      }
      throw e;
    }
    const r = await pool.query('select * from nx_mail_users where id = $1', [id]);
    return giveToken(res, r.rows[0], 201);
  }

  /* вход по адресу */
  if (p === '/api/auth/login' && req.method === 'POST') {
    const b = await rb(req);
    const r = await pool.query('select * from nx_mail_users where handle = $1', [cl(b.handle)]);
    const u = r.rows[0];
    if (!u || !u.pass || !cp(String(b.password || ''), u.pass)) {
      return js(res, 401, { error: 'Неверный адрес или пароль' });
    }
    return giveToken(res, u, 200);
  }

  /* вход через мессенджер: имя и пароль */
  if (p === '/api/auth/nevix-pass' && req.method === 'POST') {
    const b = await rb(req);
    const name = String(b.nevixName || '').trim();
    const pass = String(b.nevixPassword || '');
    if (!name || !pass) return js(res, 400, { error: 'Напишите имя и пароль от мессенджера' });
    if (!CHAT) return js(res, 501, { error: 'Вход через мессенджер не настроен на сервере' });
    let token = '';
    try {
      const r = await fetch(CHAT + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, password: pass })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.token) return js(res, 401, { error: d.error || 'Мессенджер не принял имя или пароль' });
      token = d.token;
    } catch (e) {
      return js(res, 502, { error: 'Мессенджер не отвечает. Попробуйте позже' });
    }
    const who = await whoInNevix(token);
    if (!who) return js(res, 401, { error: 'Не получилось подтвердить аккаунт мессенджера' });
    return giveToken(res, await userForNevix(who), 200);
  }

  /* вход через мессенджер: по токену */
  if (p === '/api/auth/nevix' && req.method === 'POST') {
    const b = await rb(req);
    const who = await whoInNevix(String(b.nevixToken || ''));
    if (!who) return js(res, 401, { error: 'Мессенджер не подтвердил аккаунт' });
    return giveToken(res, await userForNevix(who), 200);
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const h = String(req.headers.authorization || '');
    const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (t) await pool.query('delete from nx_mail_tokens where token = $1', [t]);
    return js(res, 200, { ok: true });
  }

  /* дальше нужен вход */
  const me = await authUser(req);
  if (!me) return js(res, 401, { error: 'Нужно войти' });

  if (p === '/api/me') {
    const un = await pool.query(
      `select count(*)::int as n from nx_mail_letters l
       left join nx_mail_flags f on f.letter_id = l.id and f.user_id = $2
       left join nx_mail_reads r on r.letter_id = l.id and r.user_id = $2
       where l.to_h = $1 and f.flag is null and r.letter_id is null`, [me.handle, me.id]);
    return js(res, 200, { user: userJson(me), unread: un.rows[0].n });
  }

  if (p === '/api/lookup') {
    const handle = cl(url.searchParams.get('handle'));
    if (!HRE.test(handle)) return js(res, 200, { exists: false });
    const r = await pool.query('select handle from nx_mail_users where handle = $1', [handle]);
    return js(res, 200, { exists: r.rowCount > 0, handle });
  }

  /* прочитать все */
  if (p === '/api/mail/readall' && req.method === 'POST') {
    await pool.query(
      `insert into nx_mail_reads (letter_id, user_id)
       select l.id, $2 from nx_mail_letters l
       left join nx_mail_flags f on f.letter_id = l.id and f.user_id = $2
       where l.to_h = $1 and f.flag is null
       on conflict do nothing`, [me.handle, me.id]);
    return js(res, 200, { ok: true });
  }

  /* список писем */
  if (p === '/api/mail' && req.method === 'GET') {
    const box = String(url.searchParams.get('box') || 'inbox');
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();

    if (box === 'drafts') {
      const r = await pool.query('select id, to_h, subj, body, updated from nx_mail_drafts where user_id = $1 order by updated desc', [me.id]);
      let list = r.rows.map((d) => ({
        id: d.id, who: d.to_h || 'Без адреса', subj: d.subj, preview: d.body, ts: d.updated, unread: false
      }));
      if (q) list = list.filter((x) => (x.who + x.subj + x.preview).toLowerCase().includes(q));
      return js(res, 200, { box, letters: list, unread: 0 });
    }

    const r = await pool.query(
      `select l.*, (r.letter_id is not null) as is_read
       from nx_mail_letters l
       left join nx_mail_flags f on f.letter_id = l.id and f.user_id = $2
       left join nx_mail_reads r on r.letter_id = l.id and r.user_id = $2
       where ${boxSql(box)} order by l.created desc limit 300`, [me.handle, me.id]);
    let list = r.rows.map((l) => {
      const out = l.from_h === me.handle;
      return {
        id: l.id, who: out ? l.to_h : l.from_h, outgoing: out, subj: l.subj,
        preview: l.body, ts: l.created, unread: box === 'inbox' && !l.is_read
      };
    });
    if (q) list = list.filter((x) => (x.who + x.subj + x.preview).toLowerCase().includes(q));
    return js(res, 200, { box, letters: list, unread: list.filter((x) => x.unread).length });
  }

  /* отправить */
  if (p === '/api/mail' && req.method === 'POST') {
    const b = await rb(req);
    const raw = String(b.to || '').trim().toLowerCase();
    const subj = String(b.subj || '').slice(0, 200);
    const body = String(b.body || '').slice(0, 20000);
    const outside = raw.includes('@') && !raw.endsWith('@' + D);
    const to = outside ? raw : cl(raw);

    if (outside) {
      if (!ERE.test(raw)) return js(res, 400, { error: 'Проверьте адрес: похоже, там опечатка', field: 'to' });
    } else if (!HRE.test(to)) {
      return js(res, 400, { error: 'Укажите адрес получателя', field: 'to' });
    }
    if (to === me.handle) return js(res, 400, { error: 'Нельзя отправить самому себе', field: 'to' });
    if (!body.trim() && !subj.trim()) return js(res, 400, { error: 'Письмо пустое', field: 'body' });
    if (outside && !outLimit(me.handle)) {
      return js(res, 429, { error: 'Слишком много писем наружу. Подождите час.' });
    }

    if (!outside) {
      const who = await pool.query('select 1 from nx_mail_users where handle = $1', [to]);
      if (!who.rowCount) {
        return js(res, 404, {
          error: 'Адреса ' + to + '@' + D + ' нет. Пока письма ходят только между адресами Nevix.',
          field: 'to'
        });
      }
    } else {
      try {
        await sendOutside(to, subj, body);
      } catch (e) {
        if (e.code === 'NOOUT') return js(res, 501, { error: e.message, field: 'to' });
        return js(res, 502, { error: e.message, field: 'body' });
      }
    }

    const id = nid('m');
    await pool.query('insert into nx_mail_letters (id, from_h, to_h, subj, body) values ($1,$2,$3,$4,$5)',
      [id, me.handle, to, subj, body]);
    if (b.draftId) await pool.query('delete from nx_mail_drafts where id = $1 and user_id = $2', [String(b.draftId), me.id]);
    return js(res, 201, { id, ok: true, outside });
  }

  /* черновики */
  if (p === '/api/drafts' && req.method === 'POST') {
    const b = await rb(req);
    const to = cl(b.to);
    const subj = String(b.subj || '').slice(0, 200);
    const body = String(b.body || '').slice(0, 20000);
    if (b.id) {
      const own = await pool.query('select 1 from nx_mail_drafts where id = $1 and user_id = $2', [String(b.id), me.id]);
      if (own.rowCount) {
        await pool.query('update nx_mail_drafts set to_h = $1, subj = $2, body = $3, updated = now() where id = $4 and user_id = $5',
          [to, subj, body, String(b.id), me.id]);
        return js(res, 200, { id: String(b.id), ok: true });
      }
    }
    const id = nid('d');
    await pool.query('insert into nx_mail_drafts (id, user_id, to_h, subj, body) values ($1,$2,$3,$4,$5)',
      [id, me.id, to, subj, body]);
    return js(res, 201, { id, ok: true });
  }

  const mDraft = p.match(/^\/api\/drafts\/([^/]+)$/);
  if (mDraft) {
    const id = decodeURIComponent(mDraft[1]);
    if (req.method === 'GET') {
      const r = await pool.query('select * from nx_mail_drafts where id = $1 and user_id = $2', [id, me.id]);
      const d = r.rows[0];
      if (!d) return js(res, 404, { error: 'Черновик не найден' });
      return js(res, 200, { draft: { id: d.id, to: d.to_h, subj: d.subj, body: d.body } });
    }
    if (req.method === 'DELETE') {
      await pool.query('delete from nx_mail_drafts where id = $1 and user_id = $2', [id, me.id]);
      return js(res, 200, { ok: true });
    }
  }

  /* одно письмо: прочитать, в папку, удалить */
  const mMail = p.match(/^\/api\/mail\/([^/]+)(\/flag)?$/);
  if (mMail) {
    const id = decodeURIComponent(mMail[1]);
    const r = await pool.query('select * from nx_mail_letters where id = $1', [id]);
    const l = r.rows[0];
    if (!l) return js(res, 404, { error: 'Письмо не найдено' });
    if (l.from_h !== me.handle && l.to_h !== me.handle) return js(res, 403, { error: 'Это не ваше письмо' });

    if (mMail[2] && req.method === 'POST') {
      const b = await rb(req);
      const flag = b.flag === null || b.flag === 'none' ? null : String(b.flag || '');
      if (flag && ['trash', 'spam'].indexOf(flag) < 0) return js(res, 400, { error: 'Неизвестная папка' });
      if (flag === null) {
        await pool.query('delete from nx_mail_flags where letter_id = $1 and user_id = $2', [id, me.id]);
      } else {
        await pool.query(
          'insert into nx_mail_flags (letter_id, user_id, flag) values ($1,$2,$3) on conflict (letter_id, user_id) do update set flag = $3',
          [id, me.id, flag]);
      }
      return js(res, 200, { ok: true, flag });
    }

    if (req.method === 'DELETE') {
                                            
