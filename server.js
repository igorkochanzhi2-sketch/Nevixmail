/**
 * NEVIX MAIL — сервер
 * Собирает три части: core (настройки), routes (адреса).
 * Файл маленький специально — чтобы его было легко загрузить с телефона.
 *
 * Переменные на Render:
 *   DATABASE_URL  — база из Neon (обязательно)
 *   RESEND_KEY    — ключ Resend для писем наружу (необязательно)
 *   MAIL_FROM     — адрес отправителя (для Resend: onboarding@resend.dev)
 *   NEVIX_CHAT_URL — адрес мессенджера для входа тем же аккаунтом (необязательно)
 */
const C = require('./core');
const { route } = require('./routes');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const server = C.http.createServer(async (req, res) => {
  const url = new C.URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const full = C.path.join(C.ROOT, file);
      if (!full.startsWith(C.ROOT) || !C.fs.existsSync(full) || C.fs.statSync(full).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('нет такой страницы');
      }
      res.writeHead(200, {
        'content-type': TYPES[C.path.extname(full)] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      return C.fs.createReadStream(full).pipe(res);
    }
    if (req.url.startsWith('/api/') && await C.tryRoute(req, res, url)) return;
    return await route(req, res, url);
  } catch (e) {
    const why = (e && (e.code || e.message)) || 'без причины';
    console.log('[mail] ошибка: ' + why + ' | ' + ((e && e.stack) || e));
    if (!res.headersSent) return C.js(res, 500, { error: 'Ошибка сервера: ' + String(why).slice(0, 120) });
    res.end();
  }
});

(async () => {
  console.log('[mail] ключи: база=' + (process.env.DATABASE_URL ? 'есть' : 'НЕТ') +
    ' resend=' + (process.env.RESEND_KEY ? 'есть' : 'нет') +
    ' отправитель=' + (process.env.MAIL_FROM || 'нет'));

  const pool = await C.makePool();
  if (pool) {
    C.setPool(pool);
    let ok = 0;
    for (const sql of C.SCHEMA) {
      try { await pool.query(sql); ok++; }
      catch (e) { console.log('[mail] таблица не создалась: ' + e.message); }
    }
    console.log('[mail] таблиц готово: ' + ok + ' из ' + C.SCHEMA.length);
  }

  server.listen(C.PORT, '0.0.0.0', () => console.log('NEVIX MAIL слушает порт ' + C.PORT));
})();
