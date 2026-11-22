const C = require('./core');
const { D, CHAT, HRE, ERE, cl, nid, ntok, hp, cp, js, rb, getPool,
  userJson, authUser, whoInNevix, userForNevix, giveToken, boxSql } = C;

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
  if (!C.OUT_READY) {
    const e = new Error('Отправка на другие адреса ещё не настроена. Пока письма ходят только между адресами Nevix.');
    e.code = 'NOOUT';
    throw e;
  }
  const safe = String(body).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = '<div style="font-family:sans-serif;font-size:16px;white-space:pre-wrap">' + safe + '</div>';
  const req = C.OUT_KIND === 'resend'
    ? {
        url: C.RESEND_URL + '/emails',
        headers: { authorization: 'Bearer ' + C.RESEND, 'content-type': 'application/json' },
        body: { from: C.FROM_NAME + ' <' + C.FROM + '>', to: [to], subject: subj || '(без темы)', text: body, html }
      }
    : {
        url: C.BREVO_URL + '/v3/smtp/email',
        headers: { 'api-key': C.BREVO, 'content-type': 'application/json' },
        body: { sender: { name: C.FROM_NAME, email: C.FROM }, to: [{ email: to }], subject: subj || '(без темы)', textContent: body, htmlContent: html }
      };
  const r = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  if (!r.ok) {
    let msg = '';
    try {
      const d = await r.json();
      msg = d.message || d.error || (d.errors && d.errors[0] && d.errors[0].message) || '';
    } catch (e) {}
    const err = new Error('Почтовый сервис не принял письмо' + (msg ? ': ' + msg : ' (код ' + r.status + ')') +
      (r.status === 403 ? '. Пока свой домен не подключён, отправлять можно только на свою почту.' : ''));
    err.code = 'OUT' + r.status;
    throw err;
  }
  return true;
}

async function route(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    let dbOk = false;
    let dbWhy = '';
    try {
      await getPool().query('select 1');
      dbOk = true;
    } catch (e) {
      dbWhy = String((e && (e.code || e.message)) || 'нет связи').slice(0, 80);
    }
    return js(res, 200, {
      ok: true, db: dbOk, dbWhy, domain: D, nevixLogin: !!CHAT,
      mailOut: C.OUT_READY, mailKind: C.OUT_KIND, time: new Date().toISOString()
    });
  }

  if (p === '/api/auth/register' && req.method === 'POST') {
    const b = await rb(req);
    const handle = cl(b.handle);
    const pass = String(b.password || '');
    if (!HRE.test(handle)) return js(res, 400, { error: 'Адрес: 3–20 символов, латиница, цифры, точка, дефис' });
    if (pass.length < 6) return js(res, 400, { error: 'Пароль от 6 символов' });
    const busy = await getPool().query('select 1 from nx_mail_users where handle = $1', [handle]);
    if (busy.rowCount) return js(res, 409, { error: 'Этот адрес уже занят' });
    const id = nid('u');
    try {
      await getPool().query('insert into nx_mail_users (id, handle, pass, via) values ($1,$2,$3,$4)',
        [id, handle, hp(pass), 'pass']);
    } catch (e) {
      if (e && (e.code === '23505' || /duplicate|unique/i.test(String(e.message)))) {
        return js(res, 409, { error: 'Этот адрес уже занят' });
      }
      throw e;
    }
    const r = await getPool().query('select * from nx_mail_users where id = $1', [id]);
    return giveToken(res, r.rows[0], 201);
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const b = await rb(req);
    const r = await getPool().query('select * from nx_mail_users where handle = $1', [cl(b.handle)]);
    const u = r.rows[0];
    if (!u || !u.pass || !cp(String(b.password || ''), u.pass)) {
      return js(res, 401, { error: 'Неверный адрес или пароль' });
    }
    return giveToken(res, u, 200);
  }

  if (p === '/api/auth/nevix-pass' && req.method === 'POST') {
    const b = await rb(req);
    const name = String(b.nevixName || '').trim();
    const pass = String(b.nevixPassword || '');
    if (!name || !pass) return js(res, 400, { error: 'Напишите имя и пароль от мессенджера' });
    if (!CHAT) return js(res, 501, { error: 'Вход через мессенджер не настроен' });
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
      return js(res, 502, { error: 'Мессенджер не отвечает' });
    }
    const who = await whoInNevix(token);
    if (!who) return js(res, 401, { error: 'Не получилось подтвердить аккаунт' });
    return giveToken(res, await userForNevix(who), 200);
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const h = String(req.headers.authorization || '');
    const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (t) await getPool().query('delete from nx_mail_tokens where token = $1', [t]);
    return js(res, 200, { ok: true });
  }

  const me = await authUser(req);
  if (!me) return js(res, 401, { error: 'Нужно войти' });

  if (p === '/api/me') {
    const un = await getPool().query(
      `select count(*)::int as n from nx_mail_letters l
       left join nx_mail_flags f on f.letter_id = l.id and f.user_id = $2
       left join nx_mail_reads r on r.letter_id = l.id and r.user_id = $2
       where l.to_h = $1 and f.flag is null and r.letter_id is null`, [me.handle, me.id]);
    return js(res, 200, { user: userJson(me), unread: un.rows[0].n });
  }

  if (p === '/api/mail/readall' && req.method === 'POST') {
    await getPool().query(
      `insert into nx_mail_reads (letter_id, user_id)
       select l.id, $2 from nx_mail_letters l
       left join nx_mail_flags f on f.letter_id = l.id and f.user_id = $2
       where l.to_h = $1 and f.flag is null
       on conflict do nothing`, [me.handle, me.id]);
    return js(res, 200, { ok: true });
  }

  if (p === '/api/mail' && req.method === 'GET') {
    const box = String(url.searchParams.get('box') || 'inbox');
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();

    if (box === 'drafts') {
      const r = await getPool().query('select id, to_h, subj, body, updated from nx_mail_drafts where user_id = $1 order by updated desc', [me.id]);
      let list = r.rows.map((d) => ({
        id: d.id, who: d.to_h || 'Без адреса', subj: d.subj, preview: d.body, ts: d.updated, unread: false
      }));
      if (q) list = list.filter((x) => (x.who + x.subj + x.preview).toLowerCase().includes(q));
      return js(res, 200, { box, letters: list, unread: 0 });
    }

    const r = await getPool().query(
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
      const who = await getPool().query('select 1 from nx_mail_users where handle = $1', [to]);
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
    await getPool().query('insert into nx_mail_letters (id, from_h, to_h, subj, body) values ($1,$2,$3,$4,$5)',
      [id, me.handle, to, subj, body]);
    if (b.draftId) await getPool().query('delete from nx_mail_drafts where id = $1 and user_id = $2', [String(b.draftId), me.id]);
    return js(res, 201, { id, ok: true, outside });
  }

  if (p === '/api/drafts' && req.method === 'POST') {
    const b = await rb(req);
    const to = cl(b.to);
    const subj = String(b.subj || '').slice(0, 200);
    const body = String(b.body || '').slice(0, 20000);
    if (b.id) {
      const own = await getPool().query('select 1 from nx_mail_drafts where id = $1 and user_id = $2', [String(b.id), me.id]);
      if (own.rowCount) {
        await getPool().query('update nx_mail_drafts set to_h = $1, subj = $2, body = $3, updated = now() where id = $4 and user_id = $5',
          [to, subj, body, String(b.id), me.id]);
        return js(res, 200, { id: String(b.id), ok: true });
      }
    }
    const id = nid('d');
    await getPool().query('insert into nx_mail_drafts (id, user_id, to_h, subj, body) values ($1,$2,$3,$4,$5)',
      [id, me.id, to, subj, body]);
    return js(res, 201, { id, ok: true });
  }

  const mDraft = p.match(/^\/api\/drafts\/([^/]+)$/);
  if (mDraft) {
    const id = decodeURIComponent(mDraft[1]);
    if (req.method === 'GET') {
      const r = await getPool().query('select * from nx_mail_drafts where id = $1 and user_id = $2', [id, me.id]);
      const d = r.rows[0];
      if (!d) return js(res, 404, { error: 'Черновик не найден' });
      return js(res, 200, { draft: { id: d.id, to: d.to_h, subj: d.subj, body: d.body } });
    }
    if (req.method === 'DELETE') {
      await getPool().query('delete from nx_mail_drafts where id = $1 and user_id = $2', [id, me.id]);
      return js(res, 200, { ok: true });
    }
  }

  const mMail = p.match(/^\/api\/mail\/([^/]+)(\/flag)?$/);
  if (mMail) {
    const id = decodeURIComponent(mMail[1]);
    const r = await getPool().query('select * from nx_mail_letters where id = $1', [id]);
    const l = r.rows[0];
    if (!l) return js(res, 404, { error: 'Письмо не найдено' });
    if (l.from_h !== me.handle && l.to_h !== me.handle) return js(res, 403, { error: 'Это не ваше письмо' });

    if (mMail[2] && req.method === 'POST') {
      const b = await rb(req);
      const flag = b.flag === null || b.flag === 'none' ? null : String(b.flag || '');
      if (flag && ['trash', 'spam'].indexOf(flag) < 0) return js(res, 400, { error: 'Неизвестная папка' });
      if (flag === null) {
        await getPool().query('delete from nx_mail_flags where letter_id = $1 and user_id = $2', [id, me.id]);
      } else {
        await getPool().query(
          'insert into nx_mail_flags (letter_id, user_id, flag) values ($1,$2,$3) on conflict (letter_id, user_id) do update set flag = $3',
          [id, me.id, flag]);
      }
      return js(res, 200, { ok: true, flag });
    }

    if (req.method === 'DELETE') {
      await getPool().query('delete from nx_mail_letters where id = $1', [id]);
      await getPool().query('delete from nx_mail_flags where letter_id = $1', [id]);
      await getPool().query('delete from nx_mail_reads where letter_id = $1', [id]);
      return js(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      const fl = await getPool().query('select flag from nx_mail_flags where letter_id = $1 and user_id = $2', [id, me.id]);
      await getPool().query('insert into nx_mail_reads (letter_id, user_id) values ($1,$2) on conflict do nothing', [id, me.id]);
      return js(res, 200, {
        letter: {
          id: l.id, from: l.from_h, to: l.to_h, outgoing: l.from_h === me.handle,
          subj: l.subj, body: l.body, ts: l.created, flag: (fl.rows[0] || {}).flag || null
        }
      });
    }
  }

  return js(res, 404, { error: 'Нет такого адреса' });
}

module.exports = { route };
