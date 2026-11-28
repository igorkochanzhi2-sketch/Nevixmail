const http = require('http');
const PORT = process.env.PORT || 3001;
const GK = process.env.GEMINI_KEY || '';
const CT = process.env.CF_TOKEN || '';
const CA = process.env.CF_ACCOUNT || '';
const CF_MODELS = (process.env.CF_MODEL ? [process.env.CF_MODEL] : ['openai/gpt-6.2-sol', '@cf/meta/llama-3.1-8b-instruct']);
const GMODELS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash'];
const SYS = 'Ты NEVIX CODE AI, помощник по коду для новичков. Отвечай по-русски, коротко, без звёздочек и без тройных кавычек. Сначала объясни ошибку в 1-2 строках, потом дай исправленный код.';
let goodG = '', goodC = '', lastFrom = '';

function j(res, c, o) {
  res.writeHead(c, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
  res.end(JSON.stringify(o));
}
function body(r) { return new Promise((x) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => x(b)); }); }

async function gemini(model, prompt) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(GK), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: SYS }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 2048 } })
  });
  const d = await r.json().catch(() => ({}));
  const t = ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).map((p) => p.text || '').join('').trim();
  return { ok: r.ok && !!t, t: t, e: (d.error && d.error.message) || ('HTTP ' + r.status) };
}

async function cf(model, prompt) {
  const url = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(CA) + '/ai/v1/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CT },
    body: JSON.stringify({ model: model, messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }], max_tokens: 2048, temperature: 0.4 })
  });
  const d = await r.json().catch(() => ({}));
  const t = ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
  const err = (d.errors && d.errors[0] && (d.errors[0].message || d.errors[0].code)) || (d.error && d.error.message) || ('HTTP ' + r.status);
  return { ok: r.ok && !!t, t: t, e: String(err) };
}

async function answer(prompt) {
  const errs = [];
  if (GK) {
    const list = goodG ? [goodG].concat(GMODELS) : GMODELS;
    for (const m of list) {
      const r = await gemini(m, prompt).catch((e) => ({ ok: false, e: String(e.message || e) }));
      if (r.ok) { goodG = m; lastFrom = 'gemini'; return r.t; }
      errs.push('G/' + m + ': ' + r.e.slice(0, 70));
    }
  }
  if (CT && CA) {
    const list = goodC ? [goodC].concat(CF_MODELS) : CF_MODELS;
    for (const m of list) {
      const r = await cf(m, prompt).catch((e) => ({ ok: false, e: String(e.message || e) }));
      if (r.ok) { goodC = m; lastFrom = 'cloudflare'; return r.t; }
      errs.push('CF/' + m + ': ' + r.e.slice(0, 70));
    }
  }
  throw new Error(errs.slice(0, 3).join(' | ') || 'Нет ни одного канала');
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' }); return res.end(); }
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/health') return j(res, 200, { ok: true, gemini: !!GK, cloudflare: !!(CT && CA), lastFrom: lastFrom || '-', modelG: goodG || '-', modelCF: goodC || '-' });

  if (u.pathname === '/probe') {
    const out = [];
    const g = await gemini('gemini-3.8-flash', 'ответь одним словом: работает').catch((e) => ({ ok: false, e: String(e.message || e) }));
    out.push('Gemini: ' + (g.ok ? 'ОК ' + g.t.slice(0, 30) : g.e.slice(0, 90)));
    for (const m of CF_MODELS) {
      const c = await cf(m, 'ответь одним словом: работает').catch((e) => ({ ok: false, e: String(e.message || e) }));
      out.push('Cloudflare ' + m + ': ' + (c.ok ? 'ОК ' + c.t.slice(0, 30) : c.e.slice(0, 90)));
      if (c.ok) break;
    }
    return j(res, 200, { out });
  }

  if (u.pathname === '/ai' && req.method === 'POST') {
    if (!GK && !(CT && CA)) return j(res, 400, { error: 'Нет ключей на сервере' });
    let d = {}; try { d = JSON.parse(await body(req)); } catch (e) { return j(res, 400, { error: 'плохой запрос' }); }
    const q = String(d.question || '').trim();
    if (!q) return j(res, 400, { error: 'пустой вопрос' });
    const p = (d.code ? 'Язык ' + d.lang + '\nКод:\n' + String(d.code).slice(0, 20000) + '\n\n' : '') + 'Вопрос: ' + q;
    try { return j(res, 200, { ok: true, text: await answer(p), from: lastFrom }); }
    catch (e) { return j(res, 502, { error: String(e.message || e).slice(0, 300) }); }
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><body style="background:#0a0a0c;color:#f4f4f7;font-family:system-ui;padding:24px"><h2>NEVIX CODE мостик</h2><p>Gemini: ' + (GK ? 'есть' : 'нет') + ' · Cloudflare: ' + (CT && CA ? 'есть' : 'нет') + '</p><p><a style="color:#ff7d8b" href="/probe">проверка</a></p></body>');
}).listen(PORT, '0.0.0.0', () => console.log('мостик на ' + PORT));
