/* NEVIX MAIL — дополнения.
   Подключается после app.js и добавляет: восстановление пароля,
   удаление аккаунта, код восстановления, даты в списке и обновление.
   Ничего не переписывает — только дополняет уже работающее. */
(function () {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tok = () => localStorage.getItem('nevixmail.token') || '';
  const app = document.getElementById('app');

  function call(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'content-type': 'application/json' }, tok() ? { authorization: 'Bearer ' + tok() } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(async (r) => {
      let d = {};
      try { d = await r.json(); } catch (e) {}
      if (!r.ok) throw new Error(d.error || 'Ошибка связи');
      return d;
    });
  }

  function say(t) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const e = document.createElement('div');
    e.className = 'toast';
    e.textContent = t;
    app.append(e);
    setTimeout(() => e.remove(), 2400);
  }

  /* ── 1. «Забыли пароль?» на экране входа ── */
  function addForgotButton() {
    if (document.querySelector('[data-forgot]')) return;
    const toreg = document.querySelector('[data-act="toreg"]');
    if (!toreg) return;
    const b = document.createElement('button');
    b.className = 'b g';
    b.setAttribute('data-forgot', '1');
    b.textContent = 'Забыли пароль?';
    toreg.parentNode.insertBefore(b, toreg.nextSibling);
  }

  function showForgot() {
    app.innerHTML = `<div class="scr" style="justify-content:center;gap:16px">
      <div class="logo"><b>N</b>NEVIX MAIL</div>
      <h1 style="margin:14px 0 0;font-size:25px">Восстановление</h1>
      <p class="m" style="margin:0;font-size:15px;line-height:1.45">Введите адрес, код восстановления (8 символов — его выдали при создании адреса, он же лежит в настройках) и новый пароль.</p>
      <div><label for="fh">Адрес</label><div class="f"><input id="fh" autocapitalize="none" placeholder="имя"><span class="m">@nevixmail.com</span></div></div>
      <div><label for="fc">Код восстановления</label><div class="f"><input id="fc" autocapitalize="characters" placeholder="A1B2-C3D4"></div></div>
      <div><label for="fp">Новый пароль</label><div class="f"><input id="fp" type="password" autocomplete="new-password"></div></div>
      <div class="err" id="ferr" role="alert"></div>
      <button class="b" data-fgo>Сменить пароль</button>
      <button class="b g" data-fback>Назад ко входу</button>
    </div>`;
  }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-forgot],[data-fgo],[data-fback],[data-rcode],[data-delgo]');
    if (!t) return;

    if (t.hasAttribute('data-forgot')) { e.preventDefault(); e.stopPropagation(); return showForgot(); }

    if (t.hasAttribute('data-fback')) {
      e.preventDefault(); e.stopPropagation();
      location.reload();
      return;
    }

    if (t.hasAttribute('data-fgo')) {
      e.preventDefault(); e.stopPropagation();
      const err = document.getElementById('ferr');
      const handle = (document.getElementById('fh').value || '').trim().toLowerCase();
      const code = (document.getElementById('fc').value || '').trim();
      const npass = document.getElementById('fp').value;
      err.textContent = '';
      if (!handle) { err.textContent = 'Напишите адрес'; return; }
      if (!code) { err.textContent = 'Напишите код восстановления'; return; }
      if (npass.length < 6) { err.textContent = 'Новый пароль от 6 символов'; return; }
      try {
        await call('/api/recover', { method: 'POST', body: { handle, code, new: npass } });
        alert('Пароль изменён. Теперь войдите с новым паролем.');
        location.reload();
      } catch (er) { err.textContent = er.message; }
      return;
    }

    if (t.hasAttribute('data-rcode')) {
      e.preventDefault(); e.stopPropagation();
      try {
        const d = await call('/api/rcode', { method: 'POST' });
        t.querySelector('span').textContent = d.code;
        say('Код восстановления обновлён');
      } catch (er) { say(er.message); }
      return;
    }

    if (t.hasAttribute('data-delgo')) {
      e.preventDefault(); e.stopPropagation();
      const err = document.getElementById('delerr');
      const password = document.getElementById('dpw').value;
      const code = document.getElementById('dcode').value;
      err.textContent = '';
      if (!password && !code) { err.textContent = 'Введите пароль или код восстановления'; return; }
      if (!confirm('Удалить адрес и все письма навсегда? Это нельзя отменить.')) return;
      try {
        await call('/api/account/delete', { method: 'POST', body: { password, code } });
        localStorage.removeItem('nevixmail.token');
        alert('Аккаунт удалён.');
        location.reload();
      } catch (er) { err.textContent = er.message; }
      return;
    }
  }, true);

  /* ── 2. настройки: код восстановления + удаление аккаунта ── */
  function patchSettings() {
    const logout = document.querySelector('[data-act="logout"]');
    if (!logout || document.querySelector('[data-rcode]')) return;

    const rcode = document.createElement('button');
    rcode.className = 'row';
    rcode.setAttribute('data-rcode', '1');
    rcode.innerHTML = '<span>Код восстановления</span><span class="m" style="font-size:15px">показать</span>';
    logout.parentNode.insertBefore(rcode, logout);

    const del = document.createElement('button');
    del.className = 'row';
    del.setAttribute('data-delform', '1');
    del.innerHTML = '<span style="color:var(--danger)">Удалить аккаунт</span>';
    logout.parentNode.insertBefore(del, logout);

    del.addEventListener('click', () => {
      if (document.getElementById('dpw')) { document.getElementById('delbox').remove(); return; }
      const box = document.createElement('div');
      box.id = 'delbox';
      box.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:12px 0';
      box.innerHTML = `<p class="m" style="margin:0;font-size:14px;line-height:1.45">Адрес и все письма удалятся навсегда. Отменить будет нельзя.</p>
        <div class="f"><input id="dpw" type="password" placeholder="Пароль"></div>
        <div class="f"><input id="dcode" autocapitalize="characters" placeholder="или код восстановления"></div>
        <div class="err" id="delerr" role="alert"></div>
        <button class="b" style="background:#a3161f" data-delgo>Удалить навсегда</button>`;
      del.parentNode.insertBefore(box, logout);
    });

    call('/api/rcode').then((d) => {
      const el = document.querySelector('[data-rcode] span:last-child');
      if (el && d.code) el.textContent = d.code;
    }).catch(() => {});
          }  
  /* ── 3. даты в списке: Сегодня / Вчера / … ── */
  function dayLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const one = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((one - that) / 86400000);
    if (diff <= 0) return 'Сегодня';
    if (diff === 1) return 'Вчера';
    if (diff < 7) return d.toLocaleDateString('ru', { weekday: 'long' });
    return d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
  }

  function patchDates() {
    const list = document.getElementById('list');
    if (!list) return;
    const nodes = Array.prototype.slice.call(list.querySelectorAll('.sw-item'));
    if (!nodes.length) return;
    nodes.forEach((n) => {
      const time = n.querySelector('.it .t span');
      if (!time) return;
      const stamp = time.getAttribute('title') || '';
      if (stamp) {
        const d = new Date(stamp);
        time.textContent = dayLabel(d) === 'Сегодня'
          ? d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
          : d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
      }
    });
  }

  /* ── 4. кнопка и автообновление ── */
  function patchRefresh() {
    const pill = document.getElementById('pill');
    if (!pill || document.querySelector('[data-refresh]')) return;
    const b = document.createElement('button');
    b.className = 'i';
    b.setAttribute('data-refresh', '1');
    b.setAttribute('aria-label', 'Обновить');
    b.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 1 3 6.2M4 20v-5h5"/></svg>';
    b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const chips = document.querySelector('.chip.on');
      if (chips) chips.click();
      say('Обновлено');
    });
    pill.parentNode.appendChild(b);
  }

  /* наблюдаем за экранами и дополняем их */
  const watch = () => {
    addForgotButton();
    patchSettings();
    patchDates();
    patchRefresh();
  };
  new MutationObserver(watch).observe(app, { childList: true, subtree: true });
  setTimeout(watch, 300);

  setInterval(() => {
    if (!tok()) return;
    const list = document.getElementById('list');
    if (!list || document.hidden) return;
    const on = document.querySelector('.chip.on');
    if (!on) return;
    const box = on.getAttribute('data-box') || 'inbox';
    call('/api/mail?box=' + encodeURIComponent(box)).then((d) => {
      const have = document.querySelectorAll('#list .sw-item').length;
      if ((d.letters || []).length !== have) on.click();
    }).catch(() => {});
  }, 45000);

  window.__MORE__ = { dayLabel };
})();
