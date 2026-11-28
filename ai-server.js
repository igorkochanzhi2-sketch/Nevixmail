/**
 * NEVIX CODE — мостик к ИИ (Gemini)
 * Крошечный сервер без зависимостей: прячет ключ и передаёт запросы в Google.
 *
 * Переменные на Render:
 *   GEMINI_KEY — ключ из Google AI Studio (обязательно)
 *   PORT       — Render задаёт сам
 *
 * Адреса:
 *   GET  /health   — есть ли ключ
 *   GET  /models   — какие модели доступны ключу
 *   POST /ai       — {question, code, lang} → {ok, text}
 */
const http = require('http');

const PORT = process.env.PORT || 3001;
const KEY = process.env.GEMINI_KEY || '';
const MODELS = (process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash']);
let goodModel = '';

const API_BASES = [
  'https://generativelanguage.googleapis.com/v1beta/models/',
  'https://generativelanguage.googleapis.com/v1/models/'
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

function json(res, code, obj) {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS));
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 300000) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}

const SYSTEM = [
  'Ты — NEVIX CODE AI, помощник по коду внутри редактора для новичков.',
  'Отвечай ПО-РУССКИ, коротко и по делу, без воды и без markdown-разметки со звёздочками.',
  'Если пользователь просит починить код — сначала объясни в 1-2 строках, что не так, потом дай исправленный код.',
  'Код оформляй обычным текстом, с отступами. Не используй тройные обратные кавычки.',
  'Если вопрос не про код — вежливо верни к теме.'
].join(' ');

async function askGemini(question, code, lang) {
  let prompt = '';
  if (code && code.trim()) {
    prompt += 'Язык: ' + (lang || 'html') + '\nКод пользователя:\n' + code.slice(0, 20000) + '\n\n';
  }
  prompt += 'Вопрос: ' + question;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
  };

  const list = goodModel ? [goodModel].concat(MODELS) : MODELS;
  const errs = [];

  for (const base of API_BASES) {
    for (const model of list) {
      try {
        const r = await fetch(base + model + ':generateContent?key=' + encodeURIComponent(KEY), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          const m = (d.error && d.error.message) || ('Google ответил ' + r.status);
          errs.push(model + ': ' + m.slice(0, 120));
          continue;
        }
        const cand = (d.candidates && d.candidates[0]) || {};
        const out = ((cand.content && cand.content.parts) || []).map((p) => p.text || '').join('').trim();
        if (!out) { errs.push(model + ': пустой ответ'); continue; }
        goodModel = model;
        return out;
      } catch (e) {
        errs.push(model + ': ' + String(e.message || e).slice(0, 120));
      }
    }
  }
  throw new Error(errs.slice(0, 4).join(' | ') || 'Не удалось получить ответ');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, hasKey: !!KEY, model: goodModel || MODELS[0], models: MODELS });
  }

  if (url.pathname === '/models') {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(KEY));
      const d = await r.json();
      const names = ((d.models) || []).map((m) => m.name.replace('models/', '')).filter((n) => n.indexOf('gemini') >= 0);
      return json(res, 200, { ok: r.ok, count: names.length, gemini: names, raw: r.ok ? undefined : d });
    } catch (e) {
      return json(res, 502, { error: String(e.message || e).slice(0, 200) });
    }
  }

  if (url.pathname === '/ai' && req.method === 'POST') {
    if (!KEY) return json(res, 400, { error: 'На сервере нет ключа GEMINI_KEY' });
    const raw = await readBody(req);
    let d;
    try { d = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'Плохой запрос' }); }

    const question = String(d.question || d.raw || '').trim();
    if (!question) return json(res, 400, { error: 'Пустой вопрос' });

    try {
      const t = await askGemini(question, String(d.code || ''), String(d.lang || ''));
      return json(res, 200, { ok: true, text: t });
    } catch (e) {
      return json(res, 502, { error: String(e.message || e).slice(0, 300) });
    }
  }

  if (url.pathname === '/') {
    res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, CORS));
    return res.end('<!doctype html><meta charset="utf-8"><body style="background:#0a0a0c;color:#f4f4f7;font-family:system-ui;padding:24px">'
      + '<h2>NEVIX CODE — мостик к ИИ</h2>'
      + '<p>Ключ: <b style="color:' + (KEY ? '#2fbf6a' : '#ff5566') + '">' + (KEY ? 'есть' : 'нет') + '</b></p>'
      + '<p>Модель: ' + (goodModel || MODELS[0]) + '</p>'
      + '<p><a style="color:#ff7d8b" href="/models">посмотреть модели</a></p></body>');
  }

  return json(res, 404, { error: 'нет такого адреса' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('NEVIX CODE мостик слушает порт ' + PORT + (KEY ? '' : ' (ключа GEMINI_KEY нет)'));
});
