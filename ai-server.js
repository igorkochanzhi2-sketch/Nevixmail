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
