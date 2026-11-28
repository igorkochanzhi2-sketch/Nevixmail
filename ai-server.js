/**
 * NEVIX CODE — мостик к ИИ (Gemini)
 * Крошечный сервер без зависимостей: прячет ключ и передаёт запросы в Google.
 *
 * Переменные на Render:
 *   GEMINI_KEY — ключ из Google AI Studio (обязательно)
 *   PORT       — Render задаёт сам
 *
 * Адреса:
 *   GET  /health          — проверка: есть ли ключ
 *   POST /ai              — {question, code, lang} → {ok, text}
 *   POST /ai  с {raw:1}   — свободный запрос
 */
const http = require('http');

const PORT = process.env.PORT || 3001;
const KEY = process.env.GEMINI_KEY || '';
// список моделей: берём первую, которая ответит (Google часто переименовывает)
const MODELS = (process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash']);
let goodModel = '';
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';

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
  const parts = [];
  let prompt = '';
  if (code && code.trim()) {
    prompt += 'Язык: ' + (lang || 'html') + '\nКод пользователя:\n' + code.slice(0, 20000) + '\n\n';
  }
  prompt += 'Вопрос: ' + question;
  parts.push({ text: prompt });

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: parts }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
  };

  const list = goodModel ? [goodModel].concat(MODELS) : MODELS;
  let lastErr = '';

  for (const model of list) {
    try {
      const r = await fetch(API + model + ':generateContent?key=' + encodeURIComponent(KEY), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastErr = (d.error && d.error.message) || ('Google ответил ' + r.status);
        continue;   // пробуем следующую модель
      }
      const cand = (d.candidates && d.candidates[0]) || {};
      const out = ((cand.content && cand.content.parts) || []).map((p) => p.text || '').join('').trim();
      if (!out) { lastErr = 'Пустой ответ от модели'; continue; }
      goodModel = model;
      return out;
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  throw new Error(lastErr || 'Не удалось получить ответ');
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
      + '<p>Этот адрес вставь в NEVIX CODE: «Ещё» → «Агент» → адрес мостика.</p></body>');
  }

  return json(res, 404, { error: 'нет такого адреса' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('NEVIX CODE мостик слушает порт ' + PORT + (KEY ? '' : ' (ключа GEMINI_KEY нет)'));
});
