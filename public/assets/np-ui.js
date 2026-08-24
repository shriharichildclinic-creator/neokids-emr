
(function (global) {
  'use strict';
  if (global.NPToast && global.NPModal) return; // idempotent

  const CSS = `
  .np-ui-toast-host{position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:10px;max-width:min(420px,calc(100vw - 32px));pointer-events:none}
  @media (max-width:480px){.np-ui-toast-host{top:auto;bottom:16px;left:16px;right:16px;max-width:none}}
  .np-ui-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:10px;background:var(--nk-card,#fff);color:var(--nk-text,#111827);border:1px solid var(--nk-border,transparent);box-shadow:0 10px 25px rgba(0,0,0,.12),0 2px 6px rgba(0,0,0,.08);border-left:4px solid #6b7280;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;opacity:0;transform:translateX(20px);transition:opacity .22s ease,transform .22s ease;will-change:opacity,transform}
  .np-ui-toast.is-visible{opacity:1;transform:translateX(0)}
  .np-ui-toast.is-leaving{opacity:0;transform:translateX(20px)}
  .np-ui-toast--success{border-left-color:#10b981}
  .np-ui-toast--warn{border-left-color:#f59e0b}
  .np-ui-toast--error{border-left-color:#ef4444}
  .np-ui-toast--info{border-left-color:#3b82f6}
  .np-ui-toast__icon{flex:0 0 20px;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700;margin-top:1px}
  .np-ui-toast--success .np-ui-toast__icon{background:#10b981}
  .np-ui-toast--warn    .np-ui-toast__icon{background:#f59e0b}
  .np-ui-toast--error   .np-ui-toast__icon{background:#ef4444}
  .np-ui-toast--info    .np-ui-toast__icon{background:#3b82f6}
  .np-ui-toast__body{flex:1;min-width:0}
  .np-ui-toast__title{font-weight:600;margin-bottom:2px}
  .np-ui-toast__msg{font-weight:500;color:#374151;word-wrap:break-word}
  .np-ui-toast__action{margin-top:6px;background:transparent;border:0;color:#89BCBD;font-weight:600;font-size:13px;cursor:pointer;padding:2px 0}
  .np-ui-toast__action:hover{text-decoration:underline}
  .np-ui-toast__close{flex:0 0 auto;background:transparent;border:0;color:#9ca3af;cursor:pointer;font-size:18px;line-height:1;padding:0;margin-left:4px}
  .np-ui-toast__close:hover{color:#374151}

  .np-ui-modal-host{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.55);backdrop-filter:blur(2px);opacity:0;transition:opacity .18s ease}
  .np-ui-modal-host.is-visible{opacity:1}
  .np-ui-modal{background:var(--nk-card,#fff);border:1px solid var(--nk-border,transparent);border-radius:14px;box-shadow:0 25px 50px -12px rgba(0,0,0,.35);max-width:440px;width:100%;padding:22px;font:500 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--nk-text,#111827);transform:scale(.96);transition:transform .18s ease}
  .np-ui-modal-host.is-visible .np-ui-modal{transform:scale(1)}
  .np-ui-modal__title{font-size:17px;font-weight:700;margin:0 0 8px;color:#0f172a}
  .np-ui-modal__message{color:#374151;margin:0 0 16px;white-space:pre-wrap}
  .np-ui-modal__input{display:block;width:100%;padding:9px 11px;border:1px solid #d1d5db;border-radius:8px;font:inherit;color:inherit;outline:none;margin-bottom:14px;box-sizing:border-box}
  .np-ui-modal__input:focus{border-color:#89BCBD;box-shadow:0 0 0 3px rgba(137,188,189,.15)}
  .np-ui-modal__actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
  .np-ui-modal__btn{padding:8px 16px;border-radius:8px;font:600 14px/1 inherit;cursor:pointer;border:1px solid transparent;background:transparent;color:#374151}
  .np-ui-modal__btn:hover{background:#f3f4f6}
  .np-ui-modal__btn--primary{background:#467878;color:#fff;border-color:#467878}
  .np-ui-modal__btn--primary:hover{background:#375F5F;border-color:#375F5F}
  .np-ui-modal__btn--danger{background:#dc2626;color:#fff;border-color:#dc2626}
  .np-ui-modal__btn--danger:hover{background:#b91c1c;border-color:#b91c1c}

  .np-ui-field-error{display:block;color:#dc2626;font-size:12.5px;font-weight:500;margin-top:4px;min-height:1em}
  .np-ui-field-invalid{border-color:#dc2626 !important;box-shadow:0 0 0 3px rgba(220,38,38,.12) !important}

  .np-ui-skel{position:relative;overflow:hidden;background:#eef1f6;border-radius:8px}
  .np-ui-skel::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.6) 50%,transparent 100%);transform:translateX(-100%);animation:np-ui-shimmer 1.3s infinite}
  @keyframes np-ui-shimmer{100%{transform:translateX(100%)}}
  .np-ui-skel--line{height:12px;margin:8px 0}
  .np-ui-skel--card{height:170px;margin:0 0 12px}
  .np-ui-skel--kpi{height:84px}

  .np-ui-empty{text-align:center;padding:28px 16px;color:#64748b}
  .np-ui-empty__icon{font-size:42px;line-height:1;margin-bottom:8px}
  .np-ui-empty__title{font-weight:700;color:#0f172a;font-size:15px;margin:0 0 4px}
  .np-ui-empty__hint{font-size:13.5px;color:#64748b;margin:0 0 12px}
  .np-ui-empty__action{background:#89BCBD;color:#fff;border:0;padding:8px 14px;border-radius:8px;font-weight:600;cursor:pointer}
  .np-ui-empty__action:hover{background:#5A9495}
  `;

  function injectStyles() {
    if (document.getElementById('np-ui-styles')) return;
    const s = document.createElement('style');
    s.id = 'np-ui-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  let toastHost = null;
  function getToastHost() {
    if (toastHost && document.body.contains(toastHost)) return toastHost;
    toastHost = document.createElement('div');
    toastHost.className = 'np-ui-toast-host';
    toastHost.setAttribute('role', 'region');
    toastHost.setAttribute('aria-live', 'polite');
    toastHost.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(toastHost);
    return toastHost;
  }

  const ICONS = { success: '✓', warn: '!', error: '×', info: 'i' };

  function show(severity, message, opts) {
    injectStyles();
    opts = opts || {};
    const host = getToastHost();
    const el = document.createElement('div');
    el.className = 'np-ui-toast np-ui-toast--' + severity;
    el.setAttribute('role', severity === 'error' ? 'alert' : 'status');

    const icon = document.createElement('div');
    icon.className = 'np-ui-toast__icon';
    icon.textContent = ICONS[severity] || 'i';
    el.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'np-ui-toast__body';
    if (opts.title) {
      const t = document.createElement('div');
      t.className = 'np-ui-toast__title';
      t.textContent = opts.title;
      body.appendChild(t);
    }
    const msg = document.createElement('div');
    msg.className = 'np-ui-toast__msg';
    msg.textContent = String(message == null ? '' : message);
    body.appendChild(msg);

    if (opts.action && typeof opts.action.onClick === 'function') {
      const a = document.createElement('button');
      a.type = 'button';
      a.className = 'np-ui-toast__action';
      a.textContent = opts.action.label || 'Undo';
      a.addEventListener('click', () => {
        try { opts.action.onClick(); } finally { dismiss(); }
      });
      body.appendChild(a);
    }
    el.appendChild(body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'np-ui-toast__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '&times;';
    close.addEventListener('click', dismiss);
    el.appendChild(close);

    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));

    const duration = opts.duration == null
      ? (severity === 'error' ? 7000 : 4500)
      : opts.duration;

    let timer = null;
    if (duration > 0) timer = setTimeout(dismiss, duration);

    function dismiss() {
      if (timer) { clearTimeout(timer); timer = null; }
      el.classList.add('is-leaving');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400);
    }

    return { dismiss };
  }

  const NPToast = {
    success: (m, o) => show('success', m, o),
    warn:    (m, o) => show('warn',    m, o),
    error:   (m, o) => show('error',   m, o),
    info:    (m, o) => show('info',    m, o),
  };

  function buildModal({ title, message, input, okText, cancelText, danger, defaultValue, placeholder, inputType }) {
    injectStyles();
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.className = 'np-ui-modal-host';
      host.setAttribute('role', 'dialog');
      host.setAttribute('aria-modal', 'true');

      const modal = document.createElement('div');
      modal.className = 'np-ui-modal';

      if (title) {
        const h = document.createElement('h3');
        h.className = 'np-ui-modal__title';
        h.textContent = title;
        modal.appendChild(h);
      }
      if (message) {
        const p = document.createElement('p');
        p.className = 'np-ui-modal__message';
        p.textContent = message;
        modal.appendChild(p);
      }

      let inputEl = null;
      if (input) {
        inputEl = document.createElement('input');
        inputEl.className = 'np-ui-modal__input';
        inputEl.type = inputType || 'text';
        if (placeholder) inputEl.placeholder = placeholder;
        if (defaultValue != null) inputEl.value = defaultValue;
        modal.appendChild(inputEl);
      }

      const actions = document.createElement('div');
      actions.className = 'np-ui-modal__actions';

      function close(value) {
        host.classList.remove('is-visible');
        setTimeout(() => host.remove(), 200);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(input ? null : false); }
        if (e.key === 'Enter' && (!inputEl || document.activeElement === inputEl)) {
          e.preventDefault();
          close(input ? (inputEl.value || '') : true);
        }
      }

      if (cancelText !== null) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'np-ui-modal__btn';
        cancel.textContent = cancelText || 'Cancel';
        cancel.addEventListener('click', () => close(input ? null : false));
        actions.appendChild(cancel);
      }
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'np-ui-modal__btn ' + (danger ? 'np-ui-modal__btn--danger' : 'np-ui-modal__btn--primary');
      ok.textContent = okText || 'OK';
      ok.addEventListener('click', () => close(input ? (inputEl.value || '') : true));
      actions.appendChild(ok);

      modal.appendChild(actions);
      host.appendChild(modal);
      host.addEventListener('click', (e) => { if (e.target === host) close(input ? null : false); });
      document.body.appendChild(host);
      document.addEventListener('keydown', onKey);
      requestAnimationFrame(() => host.classList.add('is-visible'));

      setTimeout(() => { if (inputEl) inputEl.focus(); else ok.focus(); }, 50);
    });
  }

  const NPModal = {
    confirm: (opts) => buildModal({
      title: opts && opts.title || 'Confirm',
      message: opts && opts.message || '',
      okText: opts && opts.okText || 'Confirm',
      cancelText: opts && opts.cancelText || 'Cancel',
      danger: !!(opts && opts.danger),
    }),
    prompt: (opts) => buildModal({
      title: opts && opts.title || 'Input required',
      message: opts && opts.message || '',
      input: true,
      placeholder: opts && opts.placeholder || '',
      defaultValue: opts && opts.defaultValue || '',
      inputType: opts && opts.inputType || 'text',
      okText: opts && opts.okText || 'OK',
      cancelText: opts && opts.cancelText || 'Cancel',
    }),
    alert: (opts) => buildModal({
      title: opts && opts.title || 'Notice',
      message: opts && opts.message || '',
      okText: opts && opts.okText || 'OK',
      cancelText: null,
    }),
  };

  const NPForm = {
    setError(input, msg) {
      if (!input) return;
      input.classList.add('np-ui-field-invalid');
      let err = input.nextElementSibling;
      if (!err || !err.classList || !err.classList.contains('np-ui-field-error')) {
        err = document.createElement('span');
        err.className = 'np-ui-field-error';
        input.parentNode.insertBefore(err, input.nextSibling);
      }
      err.textContent = msg || '';
    },
    clearError(input) {
      if (!input) return;
      input.classList.remove('np-ui-field-invalid');
      const err = input.nextElementSibling;
      if (err && err.classList && err.classList.contains('np-ui-field-error')) {
        err.textContent = '';
      }
    },
    clearAll(form) {
      if (!form) return;
      form.querySelectorAll('.np-ui-field-invalid').forEach((el) => el.classList.remove('np-ui-field-invalid'));
      form.querySelectorAll('.np-ui-field-error').forEach((el) => { el.textContent = ''; });
    },
  };

  const _INR = (typeof Intl !== 'undefined' && Intl.NumberFormat)
    ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
    : null;
  const _INR2 = (typeof Intl !== 'undefined' && Intl.NumberFormat)
    ? new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : null;
  const NPFmt = {
    inr(value, opts) {
      opts = opts || {};
      const n = Number(value);
      if (!Number.isFinite(n)) return '—';
      const fmt = opts.decimals === 2 ? _INR2 : _INR;
      const s = fmt ? fmt.format(n) : String(Math.round(n));
      return '₹' + s;
    },
    shortRef(uuid) {
      if (!uuid) return '';
      const yr = new Date().getFullYear();
      let h = 0;
      for (let i = 0; i < uuid.length; i++) h = (h * 31 + uuid.charCodeAt(i)) >>> 0;
      const code = String(h % 10000).padStart(4, '0');
      return `NK-${yr}-${code}`;
    },
    // Renders a "▲ 3 vs yesterday" / "▼ 12% this week" style trend chip.
    // Was copy-pasted byte-for-byte across Admin (app.js + finance.js),
    // Doctor, Receptionist and Pharmacy dashboards — one shared copy here.
    trendChip(delta, label, isPercent) {
      if (!delta) return `<span class="np-trend np-trend--flat">No change ${label}</span>`;
      const up = delta > 0;
      const val = isPercent ? `${Math.abs(delta)}%` : Math.abs(delta);
      return `<span class="np-trend ${up ? 'np-trend--up' : 'np-trend--down'}">${up ? '▲' : '▼'} ${val} ${label}</span>`;
    },
  };

  const NPSkeleton = {
    list(host, count) {
      if (!host) return;
      injectStyles();
      const n = Math.max(1, count || 6);
      host.innerHTML = Array.from({ length: n }, () =>
        '<div class="np-ui-skel np-ui-skel--line" style="width:' + (60 + Math.floor(Math.random() * 35)) + '%"></div>'
      ).join('');
    },
    cards(host, count) {
      if (!host) return;
      injectStyles();
      const n = Math.max(1, count || 4);
      host.innerHTML = Array.from({ length: n }, () =>
        '<div class="np-ui-skel np-ui-skel--card"></div>'
      ).join('');
    },
    kpis(host, count) {
      if (!host) return;
      injectStyles();
      const n = Math.max(1, count || 4);
      host.innerHTML = Array.from({ length: n }, () =>
        '<div class="np-ui-skel np-ui-skel--kpi"></div>'
      ).join('');
    },
  };

  const NPEmpty = {
    render(host, opts) {
      if (!host) return;
      injectStyles();
      opts = opts || {};
      const icon  = opts.icon  || '📭';
      const title = opts.title || 'Nothing here yet';
      const hint  = opts.hint  || '';
      const action = opts.action;
      const wrap = document.createElement('div');
      wrap.className = 'np-ui-empty';
      wrap.innerHTML =
        '<div class="np-ui-empty__icon" aria-hidden="true">' + icon + '</div>' +
        '<p class="np-ui-empty__title"></p>' +
        (hint ? '<p class="np-ui-empty__hint"></p>' : '');
      wrap.querySelector('.np-ui-empty__title').textContent = title;
      if (hint) wrap.querySelector('.np-ui-empty__hint').textContent = hint;
      if (action && typeof action.onClick === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'np-ui-empty__action';
        btn.textContent = action.label || 'Action';
        btn.addEventListener('click', action.onClick);
        wrap.appendChild(btn);
      }
      host.innerHTML = '';
      host.appendChild(wrap);
    },
  };

  function _decodeJwtExpMs(token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload && payload.exp ? payload.exp * 1000 : 0;
    } catch (_) { return 0; }
  }
  let _sessionTimer = null;
  const NPSession = {
    start(token, opts) {
      if (_sessionTimer) { clearTimeout(_sessionTimer); _sessionTimer = null; }
      if (!token) return;
      const exp = _decodeJwtExpMs(token);
      if (!exp) return;
      const warnBefore = (opts && opts.warnBeforeMs) || 10 * 60 * 1000;
      const fireAt = exp - warnBefore - Date.now();
      if (fireAt <= 0) return;
      _sessionTimer = setTimeout(() => {
        NPToast.warn('Your session expires in 10 minutes. Save your work.', {
          title: 'Session expiring',
          duration: 15000,
        });
      }, fireAt);
    },
    stop() { if (_sessionTimer) { clearTimeout(_sessionTimer); _sessionTimer = null; } },
  };

  global.nativeAlert   = global.alert;
  global.nativeConfirm = global.confirm;
  global.nativePrompt  = global.prompt;

  global.alert = function (msg) {
    const s = String(msg || '');
    if (/^(❌|⚠|Error|Failed)/i.test(s))                NPToast.error(s);
    else if (/^(✓|✅|Success|Saved|Updated)/i.test(s))    NPToast.success(s);
    else if (/^(ℹ|Note|Info)/i.test(s))                  NPToast.info(s);
    else                                                  NPToast.info(s);
  };
  global.confirm = function (msg) {
    return NPModal.confirm({ message: String(msg || '') });
  };
  global.prompt = function (msg, def) {
    return NPModal.prompt({ message: String(msg || ''), defaultValue: def || '' });
  };

  global.NPToast    = NPToast;
  global.NPModal    = NPModal;
  global.NPForm     = NPForm;
  global.NPFmt      = NPFmt;
  global.NPSkeleton = NPSkeleton;
  global.NPEmpty    = NPEmpty;
  global.NPSession  = NPSession;
})(window);

(function (global) {
  'use strict';
  if (global.NPTheme && global.NPPalette) return;

  const CSS = `
  
  html[data-theme="dark"] .np-ui-toast{
    background:#11202A;color:#E6EEF1;border:1px solid #234551;
    box-shadow:0 12px 30px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35);
  }
  html[data-theme="dark"] .np-ui-toast__msg{color:#C8D5DB}
  html[data-theme="dark"] .np-ui-toast__close{color:#91A6B0}
  html[data-theme="dark"] .np-ui-toast__close:hover{color:#E6EEF1}
  html[data-theme="dark"] .np-ui-modal{background:#11202A;color:#E6EEF1;border:1px solid #234551}
  html[data-theme="dark"] .np-ui-modal__title{color:#F4F9FA}
  html[data-theme="dark"] .np-ui-modal__message{color:#C8D5DB}
  html[data-theme="dark"] .np-ui-modal__input{background:#0E1A22;color:#E6EEF1;border-color:#234551}
  html[data-theme="dark"] .np-ui-modal__btn{color:#C8D5DB}
  html[data-theme="dark"] .np-ui-modal__btn:hover{background:rgba(137,188,189,.14);color:#B4D7D7}
  /* The two rules above set a light-gray text color meant for the plain
     Cancel button. Because .np-ui-modal__btn--primary/--danger also carry
     the base .np-ui-modal__btn class, that gray was silently overriding
     their intended white text in dark mode too — the exact WCAG-AA
     contrast bug reported on Generate Settlement, just re-triggered by
     dark mode. Locking primary/danger to white here, in both states,
     stops that leak for every confirm/alert dialog app-wide. */
  html[data-theme="dark"] .np-ui-modal__btn--primary,
  html[data-theme="dark"] .np-ui-modal__btn--primary:hover,
  html[data-theme="dark"] .np-ui-modal__btn--danger,
  html[data-theme="dark"] .np-ui-modal__btn--danger:hover{color:#fff}
  html[data-theme="dark"] .np-ui-skel{background:#1B2F39}
  html[data-theme="dark"] .np-ui-skel::after{background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.08) 50%,transparent 100%)}
  html[data-theme="dark"] .np-ui-empty{color:#91A6B0}
  html[data-theme="dark"] .np-ui-empty__title{color:#F4F9FA}
  html[data-theme="dark"] .np-ui-empty__hint{color:#91A6B0}

  .np-theme-toggle{
    position:fixed; right:14px; bottom:14px; z-index:90;
    width:42px; height:42px; border-radius:50%; border:0; cursor:pointer;
    background:#89BCBD; color:#fff; font-size:20px; line-height:1;
    box-shadow:0 8px 22px rgba(137,188,189,.35);
  }
  .np-theme-toggle:hover{ background:#5A9495; }
  @media (max-width:600px){ .np-theme-toggle{ right:10px; bottom:74px; } }

.np-palette-host{position:fixed;inset:0;z-index:100001;display:flex;align-items:flex-start;justify-content:center;padding:10vh 16px 16px;background:rgba(15,23,42,.5);backdrop-filter:blur(2px);opacity:0;transition:opacity .15s ease}
  .np-palette-host.is-visible{opacity:1}
  .np-palette{width:100%;max-width:560px;background:var(--nk-card,#fff);border:1px solid var(--nk-border,transparent);border-radius:14px;box-shadow:0 25px 50px -12px rgba(0,0,0,.4);overflow:hidden;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--nk-text,#111827)}
  html[data-theme="dark"] .np-palette{background:#11202A;color:#E6EEF1;border:1px solid #234551}
  .np-palette__input{display:block;width:100%;border:0;outline:0;padding:14px 16px;font-size:15px;background:transparent;color:inherit;border-bottom:1px solid #e5e7eb}
  html[data-theme="dark"] .np-palette__input{border-bottom-color:#234551;color:#E6EEF1}
  .np-palette__list{max-height:50vh;overflow-y:auto;list-style:none;margin:0;padding:6px 0}
  .np-palette__item{padding:9px 16px;cursor:pointer;display:flex;align-items:center;gap:10px}
  .np-palette__item.is-active{background:#F1F7F7;color:#5A9495}
  html[data-theme="dark"] .np-palette__item{color:#E6EEF1}
  html[data-theme="dark"] .np-palette__item.is-active{background:rgba(137,188,189,.20);color:#B4D7D7}
  html[data-theme="dark"] .np-palette__item__hint{color:#91A6B0}
  html[data-theme="dark"] .np-palette__empty{color:#91A6B0}
  html[data-theme="dark"] .np-palette-host{background:rgba(2,8,12,.65)}
  .np-palette__item__hint{margin-left:auto;font-size:12px;color:#9ca3af}
  .np-palette__empty{padding:20px;text-align:center;color:#9ca3af;font-size:13px}

.np-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0}
  .np-chip{display:inline-flex;align-items:center;gap:4px;background:#F1F7F7;color:#467878;border:1px solid #DCEBEB;border-radius:999px;padding:3px 4px 3px 10px;font-size:12.5px;font-weight:500}
  html[data-theme="dark"] .np-chip{background:rgba(137,188,189,.20);color:#B4D7D7;border-color:rgba(137,188,189,.40)}
  .np-chip__x{background:transparent;border:0;cursor:pointer;color:inherit;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:13px}
  .np-chip__x:hover{background:rgba(0,0,0,.06)}
  .np-chips__clear{background:transparent;border:0;color:#dc2626;cursor:pointer;font-size:12.5px;font-weight:600;margin-left:4px}
  .np-chips__clear:hover{text-decoration:underline}

.np-daterange{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  .np-daterange__btn{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:4px 10px;font-size:12.5px;font-weight:500;color:#1e293b;cursor:pointer}
  .np-daterange__btn:hover{background:#e2e8f0}
  .np-daterange__btn.is-active{background:#89BCBD;color:#fff;border-color:#89BCBD}
  html[data-theme="dark"] .np-daterange__btn{background:#142531;color:#E6EEF1;border-color:#234551}
  html[data-theme="dark"] .np-daterange__btn:hover{background:rgba(137,188,189,.14);border-color:rgba(137,188,189,.40)}
  html[data-theme="dark"] .np-daterange__btn.is-active{background:#89BCBD;color:#fff;border-color:#89BCBD}

html[data-theme="dark"] .np-dropzone{background:#0E1A22;color:#91A6B0;border-color:#234551}
  html[data-theme="dark"] .np-dropzone:hover,
  html[data-theme="dark"] .np-dropzone.is-drag{background:rgba(137,188,189,.10);border-color:#A4CDCE;color:#B4D7D7}

html[data-theme="dark"] .np-sticky-head thead th{background:#0E1A22}

.np-dropzone{display:block;border:2px dashed #cbd5e1;border-radius:10px;padding:18px;text-align:center;color:#64748b;background:#f8fafc;cursor:pointer;transition:background .15s,border-color .15s}
  .np-dropzone:hover,.np-dropzone.is-drag{background:#F1F7F7;border-color:#89BCBD;color:#5A9495}
  .np-dropzone__hint{font-size:12.5px;margin-top:4px}
  .np-dropzone input{display:none}
  /* input[type="file"].np-input in neokids-theme.css (used by the KYC card
     inputs) has higher specificity than the rule above, so it was winning
     and forcing the native "Choose File / No file chosen" control visible
     underneath the styled dropzone — beat it explicitly. */
  .np-dropzone input[type="file"].np-input{display:none}

  /* Pre-upload preview (opt-in via NPDropzone.bind(input,{preview:true})) —
     an image thumbnail or a filename badge for the file just picked, shown
     before the caller's own "Upload" action has fired anything. */
  .np-dropzone__preview{margin-top:8px}
  .np-dropzone__preview:empty{margin-top:0}
  .np-dropzone__preview-img{max-width:100%;max-height:120px;border-radius:8px;border:1px solid #E2E8F0;object-fit:contain;background:#fff}
  html[data-theme="dark"] .np-dropzone__preview-img{border-color:#234551;background:#0E1A22}
  .np-dropzone__preview-file{font-size:12.5px;font-weight:600;color:#475569;background:#fff;border:1px solid #E2E8F0;border-radius:8px;padding:.4rem .6rem;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  html[data-theme="dark"] .np-dropzone__preview-file{color:#B4D7D7;background:#0E1A22;border-color:#234551}

  /* Selected-file controls: appear the instant a file is picked (before
     any upload request fires), and disappear the instant it's cleared —
     no waiting on a network round trip either way. */
  .np-dropzone__selected{display:none;align-items:center;justify-content:center;gap:8px;margin-top:8px;flex-wrap:wrap}
  .np-dropzone__selected.is-visible{display:flex}
  .np-dropzone__clear{font-size:12px;font-weight:600;color:#B0413E;background:#fff;border:1px solid #E7B4B0;border-radius:8px;padding:.3rem .6rem;cursor:pointer;line-height:1.2}
  .np-dropzone__clear:hover{background:#FBEAE9}
  html[data-theme="dark"] .np-dropzone__clear{color:#F0A6A2;background:#0E1A22;border-color:#5B3230}
  html[data-theme="dark"] .np-dropzone__clear:hover{background:#241615}

.np-sticky-head thead th{position:sticky;top:0;z-index:5;background:inherit}

.np-lightbox{position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;padding:32px;background:rgba(8,12,18,.82);opacity:0;transition:opacity .15s ease;cursor:zoom-out}
  .np-lightbox.is-visible{opacity:1}
  .np-lightbox__img{max-width:min(90vw,560px);max-height:85vh;border-radius:16px;box-shadow:0 25px 60px -12px rgba(0,0,0,.6);object-fit:contain;cursor:default}
  .np-lightbox__close{position:absolute;top:16px;right:20px;width:40px;height:40px;border-radius:50%;border:0;background:rgba(255,255,255,.12);color:#fff;font-size:24px;line-height:1;cursor:pointer;display:grid;place-items:center}
  .np-lightbox__close:hover{background:rgba(255,255,255,.22)}

  .np-notif{position:relative;display:inline-flex}
  .np-notif__btn{position:relative;width:40px;height:40px;border-radius:10px;border:1px solid var(--nk-border,#D9E6E6);background:var(--nk-card,#fff);color:var(--nk-muted,#64748b);cursor:pointer;display:grid;place-items:center;flex-shrink:0}
  .np-notif__btn:hover{color:var(--nk-teal-600,#5A9495);border-color:var(--nk-teal-200,#BFDCDC)}
  .np-notif__dot{position:absolute;top:6px;right:6px;min-width:16px;height:16px;padding:0 3px;border-radius:999px;background:#DC2626;color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center}
  .np-notif__panel{position:absolute;top:calc(100% + 8px);right:0;width:340px;max-height:70vh;overflow-y:auto;background:var(--nk-card,#fff);border:1px solid var(--nk-border,#D9E6E6);border-radius:12px;box-shadow:0 20px 45px -15px rgba(15,46,58,.35);z-index:9000;display:none}
  /* Below ~600px, position:absolute anchored to the bell's own tiny wrapper
     only stays on-screen if that wrapper happens to sit flush against the
     viewport edge — it doesn't reliably in a cramped mobile header (other
     icons/avatar crowd it inward). Switch to position:fixed with BOTH left
     and right set (no width) so the browser stretches it to exactly fit
     between two viewport-relative margins — it cannot overflow either
     edge regardless of where the bell itself ends up. The top offset is
     set inline by JS at open-time from the button's actual position,
     since header height differs per portal. */
  @media (max-width:600px){
    .np-notif__panel{position:fixed;left:12px;right:12px;width:auto;max-height:min(70vh,480px)}
  }
  .np-notif__panel.is-open{display:block}
  .np-notif__head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--nk-border,#D9E6E6);font-weight:700;font-size:.88rem;color:var(--nk-ink,#0F2E3A)}
  .np-notif__markall{background:none;border:0;color:var(--nk-teal-600,#5A9495);font-size:.76rem;font-weight:600;cursor:pointer;padding:0}
  .np-notif__markall:hover{text-decoration:underline}
  .np-notif__item{display:block;width:100%;text-align:left;padding:10px 14px;border:0;border-bottom:1px solid var(--nk-border,#EEF3F3);background:transparent;cursor:pointer;font:inherit}
  .np-notif__item:last-child{border-bottom:0}
  .np-notif__item:hover{background:var(--nk-teal-50,#F1F7F7)}
  .np-notif__item.is-unread{background:rgba(137,188,189,.08)}
  .np-notif__item-title{display:flex;align-items:center;gap:6px;font-weight:700;font-size:.82rem;color:var(--nk-ink,#0F2E3A);min-width:0;overflow-wrap:anywhere;word-break:break-word}
  .np-notif__item-dot{width:7px;height:7px;border-radius:50%;background:#89BCBD;flex-shrink:0}
  .np-notif__item-msg{font-size:.78rem;color:var(--nk-muted,#64748b);margin-top:2px;overflow-wrap:anywhere;word-break:break-word}
  .np-notif__item-time{font-size:.7rem;color:var(--nk-muted,#94a3b8);margin-top:4px}
  .np-notif__empty{padding:28px 14px;text-align:center;font-size:.82rem;color:var(--nk-muted,#64748b)}
  html[data-theme="dark"] .np-notif__btn{background:#11202A;border-color:#234551;color:#91A6B0}
  html[data-theme="dark"] .np-notif__panel{background:#11202A;border-color:#234551}
  html[data-theme="dark"] .np-notif__head{border-color:#234551;color:#F4F9FA}
  html[data-theme="dark"] .np-notif__item{border-color:#1B333D}
  html[data-theme="dark"] .np-notif__item:hover{background:rgba(137,188,189,.08)}
  html[data-theme="dark"] .np-notif__item-title{color:#F4F9FA}

  .np-spark-tooltip{position:fixed;z-index:99998;background:var(--nk-card,#fff);color:var(--nk-ink,#0F2E3A);border:1px solid var(--nk-border,#D9E6E6);border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.08);padding:.5rem .65rem;min-width:150px;font:500 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease}
  .np-spark-tooltip.is-visible{opacity:1;visibility:visible}
  .np-spark-tooltip.is-pinned{pointer-events:auto}
  .np-spark-tooltip__title{font-size:.72rem;font-weight:700;color:var(--nk-ink,#0F2E3A)}
  .np-spark-tooltip__value{font-size:.82rem;font-weight:700;color:var(--nk-teal-700,#5A9495);margin-top:.1rem}
  .np-spark-tooltip__link{display:block;width:100%;margin-top:.4rem;padding-top:.4rem;border:0;border-top:1px dashed var(--nk-border,#D9E6E6);background:transparent;color:var(--nk-teal-700,#5A9495);font-size:.72rem;font-weight:700;text-align:left;cursor:pointer}
  .np-spark-tooltip__link:hover{text-decoration:underline}
  html[data-theme="dark"] .np-spark-tooltip{background:#11202A;color:#E6EEF1;border-color:#234551;box-shadow:0 12px 30px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35)}
  html[data-theme="dark"] .np-spark-tooltip__title{color:#F4F9FA}
  html[data-theme="dark"] .np-spark-tooltip__value{color:#B4D7D7}
  html[data-theme="dark"] .np-spark-tooltip__link{color:#B4D7D7;border-top-color:#234551}
  `;

  function injectStyles() {
    if (document.getElementById('np-ux-styles')) return;
    const s = document.createElement('style');
    s.id = 'np-ux-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // Native date/time inputs only open their picker when the tiny calendar
  // glyph is clicked — everywhere else in the field just moves the text
  // cursor. Delegate clicks anywhere on the field to showPicker() so the
  // whole box is clickable, consistent across Admin/Doctor/Receptionist/
  // Pharmacy and across desktop, tablet and mobile. Delegated on document
  // because these panels render date fields dynamically via template
  // strings, so a one-time querySelectorAll at load time would miss them.
  const NPDatePicker = {
    init() {
      document.addEventListener('mousedown', (e) => {
        const el = e.target && e.target.closest
          ? e.target.closest('input[type="date"], input[type="time"], input[type="datetime-local"]')
          : null;
        if (!el || el.disabled || el.readOnly) return;
        if (typeof el.showPicker !== 'function') return;
        try { el.showPicker(); } catch (_) { /* no active user gesture / unsupported */ }
      });
    },
  };

  // Theme controller. The floating header/nav toggle has been removed;
  // Settings is the single source of truth for switching Dark Mode.
  const NPTheme = {
    init() {
      injectStyles();
      const saved = (function () { try { return localStorage.getItem('np-theme'); } catch (_) { return null; } })();
      const dark = saved
        ? saved === 'dark'
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      this.set(dark ? 'dark' : 'light');

      // Explicitly clean up any legacy floating toggle that a previous
      // build may have left in the DOM (defensive).
      const legacy = document.getElementById('np-theme-toggle');
      if (legacy && legacy.parentNode) legacy.parentNode.removeChild(legacy);
    },
    set(mode) {
      document.documentElement.setAttribute('data-theme', mode);
      try { localStorage.setItem('np-theme', mode); } catch (_) {}
      document.dispatchEvent(new CustomEvent('np-theme-change', { detail: { mode: mode } }));
    },
    toggle() {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      this.set(cur === 'dark' ? 'light' : 'dark');
    },
    current() {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    },
  };

  const _commands = [];
  let _paletteHost = null;

  function _renderPaletteList(listEl, items, activeIdx, query) {
    listEl.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'np-palette__empty';
      empty.textContent = query ? 'No commands match “' + query + '”' : 'Type to search…';
      listEl.appendChild(empty);
      return;
    }
    items.forEach((cmd, i) => {
      const li = document.createElement('li');
      li.className = 'np-palette__item' + (i === activeIdx ? ' is-active' : '');
      li.innerHTML =
        '<span>' + (cmd.icon || '•') + '</span>' +
        '<span class="np-palette__item__label"></span>' +
        (cmd.hint ? '<span class="np-palette__item__hint"></span>' : '');
      li.querySelector('.np-palette__item__label').textContent = cmd.label;
      if (cmd.hint) li.querySelector('.np-palette__item__hint').textContent = cmd.hint;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); cmd.run(); NPPalette.close(); });
      listEl.appendChild(li);
    });
  }

  function _openPalette() {
    if (_paletteHost) return;
    injectStyles();
    _paletteHost = document.createElement('div');
    _paletteHost.className = 'np-palette-host';
    _paletteHost.innerHTML =
      '<div class="np-palette" role="dialog" aria-modal="true" aria-label="Command palette">' +
        '<input class="np-palette__input" type="text" placeholder="Type a command…" autocomplete="off" />' +
        '<ul class="np-palette__list" role="listbox"></ul>' +
      '</div>';
    document.body.appendChild(_paletteHost);
    requestAnimationFrame(() => _paletteHost.classList.add('is-visible'));

    const input = _paletteHost.querySelector('.np-palette__input');
    const list  = _paletteHost.querySelector('.np-palette__list');
    let active = 0;
    let visible = _commands.slice();
    _renderPaletteList(list, visible, active, '');

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      visible = _commands.filter(c => !q || (c.label + ' ' + (c.keywords || '')).toLowerCase().includes(q));
      active = 0;
      _renderPaletteList(list, visible, active, input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (visible.length) { active = (active + 1) % visible.length; _renderPaletteList(list, visible, active, input.value); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (visible.length) { active = (active - 1 + visible.length) % visible.length; _renderPaletteList(list, visible, active, input.value); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (visible[active]) { visible[active].run(); NPPalette.close(); } }
      else if (e.key === 'Escape') { e.preventDefault(); NPPalette.close(); }
    });
    _paletteHost.addEventListener('click', (e) => { if (e.target === _paletteHost) NPPalette.close(); });
    setTimeout(() => input.focus(), 30);
  }

  const NPPalette = {
    register(cmd) {
      if (!cmd || !cmd.label || typeof cmd.run !== 'function') return;
      _commands.push(cmd);
    },
    open: _openPalette,
    close() {
      if (!_paletteHost) return;
      _paletteHost.classList.remove('is-visible');
      const host = _paletteHost; _paletteHost = null;
      setTimeout(() => host.remove(), 150);
    },
    list() { return _commands.slice(); },
  };

  function _isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault(); NPPalette.open(); return;
    }
    if (_isTypingTarget(e.target)) return;
    if (e.key === '/') {
      const search = document.querySelector('.np-search input, .np-search, [data-np-search], input[type="search"]');
      if (search) { e.preventDefault(); search.focus(); }
    }
    else if (e.key === '?') {
      e.preventDefault();
      if (global.NPModal) {
        NPModal.alert({
          title: 'Keyboard shortcuts',
          message:
            '⌘/Ctrl + K   Open command palette\n' +
            '/             Focus search\n' +
            '?             Show this help\n' +
            'D             Toggle dark mode\n' +
            'Esc           Close modal / palette',
        });
      }
    }
    else if (e.key === 'd' || e.key === 'D') {
      NPTheme.toggle();
    }
  });

  const NPChips = {
    render(host, chips, onClearAll) {
      if (!host) return;
      injectStyles();
      const arr = (chips || []).filter(c => c && c.label);
      if (!arr.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
      host.style.display = '';
      host.className = (host.className || '').replace(/\bnp-chips\b/g, '').trim() + ' np-chips';
      host.innerHTML = '';
      arr.forEach(c => {
        const chip = document.createElement('span');
        chip.className = 'np-chip';
        chip.innerHTML = '<span></span><button class="np-chip__x" type="button" aria-label="Remove filter">&times;</button>';
        chip.firstElementChild.textContent = c.label;
        chip.querySelector('.np-chip__x').addEventListener('click', () => { try { c.onClear && c.onClear(); } catch (_) {} });
        host.appendChild(chip);
      });
      if (typeof onClearAll === 'function' && arr.length > 1) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'np-chips__clear'; btn.textContent = 'Clear all';
        btn.addEventListener('click', onClearAll);
        host.appendChild(btn);
      }
    },
  };

  function _isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function _startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
  const NPDateRange = {
    presets() {
      const today = _startOfDay(new Date());
      const day = 24 * 3600 * 1000;
      const yesterday = new Date(today.getTime() - day);
      const last7  = new Date(today.getTime() - 6 * day);
      const last30 = new Date(today.getTime() - 29 * day);
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0);
      const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
      return [
        { key: 'today',     label: 'Today',       from: today,           to: today },
        { key: 'yesterday', label: 'Yesterday',   from: yesterday,       to: yesterday },
        { key: 'last7',     label: 'Last 7 days', from: last7,           to: today },
        { key: 'last30',    label: 'Last 30 days',from: last30,          to: today },
        { key: 'month',     label: 'This month',  from: monthStart,      to: today },
        { key: 'lastmonth', label: 'Last month',  from: lastMonthStart,  to: lastMonthEnd },
      ];
    },
    render(host, onChange) {
      if (!host) return;
      injectStyles();
      const presets = this.presets();
      host.className = (host.className || '').replace(/\bnp-daterange\b/g, '').trim() + ' np-daterange';
      host.innerHTML = '';
      presets.forEach(p => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'np-daterange__btn'; b.textContent = p.label;
        b.dataset.key = p.key;
        b.addEventListener('click', () => {
          host.querySelectorAll('.np-daterange__btn').forEach(x => x.classList.remove('is-active'));
          b.classList.add('is-active');
          try { onChange && onChange({ key: p.key, fromIso: _isoDate(p.from), toIso: _isoDate(p.to) }); } catch (_) {}
        });
        host.appendChild(b);
      });
    },
  };

  const NPDropzone = {
    bind(input, opts) {
      if (!input || input.dataset.npDz === '1') return;
      injectStyles();
      input.dataset.npDz = '1';
      opts = opts || {};
      const wrap = document.createElement('label');
      wrap.className = 'np-dropzone';
      wrap.innerHTML =
        '<div><strong>' + (opts.label || 'Drop file here') + '</strong></div>' +
        '<div class="np-dropzone__hint">' + (opts.hint || 'or click to browse') + '</div>';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      const status = document.createElement('div');
      status.className = 'np-dropzone__hint'; status.style.marginTop = '6px';
      wrap.appendChild(status);

      // Opt-in thumbnail/file preview shown the moment a file is picked —
      // before the caller's own "Upload" action fires — so the admin can
      // confirm it's the right scan (and isn't upside-down, cropped, etc.)
      // instead of finding out only after it's already saved. Off by
      // default so the plain doctor-photo dropzone (which has its own
      // circular avatar preview elsewhere) doesn't change appearance.
      let previewEl = null;
      let objectUrl = null;
      let clearWrap = null;
      let clearBtn = null;
      if (opts.preview) {
        previewEl = document.createElement('div');
        previewEl.className = 'np-dropzone__preview';
        wrap.appendChild(previewEl);

        // "Remove" control for a file that's only been picked, not yet
        // uploaded — shows the moment a file lands in the input, and
        // clearing it here is purely local (nothing's been sent to the
        // server yet, so there's nothing to delete server-side).
        clearWrap = document.createElement('div');
        clearWrap.className = 'np-dropzone__selected';
        clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'np-dropzone__clear';
        clearBtn.textContent = 'Remove';
        clearWrap.appendChild(clearBtn);
        wrap.appendChild(clearWrap);

        clearBtn.addEventListener('click', (e) => {
          // Stop this from bubbling up to the <label> that wraps the
          // input — a click anywhere in the label would otherwise
          // reopen the native file picker instead of just clearing it.
          e.preventDefault();
          e.stopPropagation();
          input.value = '';
          updateStatus();
        });
      }

      function clearPreview() {
        if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
        if (previewEl) previewEl.innerHTML = '';
        if (clearWrap) clearWrap.classList.remove('is-visible');
      }

      function renderPreview(f) {
        if (!f) return;
        clearPreview();
        // Show the Remove control immediately, before attempting the
        // thumbnail — a JPG's image decode/thumbnail is a "nice to have"
        // and shouldn't be a precondition for the control existing. This
        // was the bug: for images the control was only added *after* the
        // thumbnail block ran, so any hiccup there (slow decode, a odd
        // file, etc.) silently left the Remove button missing. PDFs have
        // no such step, which is why only images were affected.
        if (clearWrap) clearWrap.classList.add('is-visible');
        if (!previewEl) return;
        try {
          if (f.type && f.type.startsWith('image/')) {
            objectUrl = URL.createObjectURL(f);
            const img = document.createElement('img');
            img.src = objectUrl;
            img.alt = 'Selected file preview';
            img.className = 'np-dropzone__preview-img';
            previewEl.appendChild(img);
          } else {
            const badge = document.createElement('div');
            badge.className = 'np-dropzone__preview-file';
            badge.textContent = (f.type === 'application/pdf' ? '📄 ' : '📎 ') + f.name;
            previewEl.appendChild(badge);
          }
        } catch (_) {
          // Thumbnail failed to render — fall back to a plain filename
          // badge rather than leaving the preview area empty.
          previewEl.innerHTML = '';
          const badge = document.createElement('div');
          badge.className = 'np-dropzone__preview-file';
          badge.textContent = '📎 ' + f.name;
          previewEl.appendChild(badge);
        }
      }

      function updateStatus() {
        const f = input.files && input.files[0];
        status.textContent = f ? ('Selected: ' + f.name + ' (' + Math.round(f.size / 1024) + ' KB)') : '';
        if (f) renderPreview(f); else clearPreview();
      }
      input.addEventListener('change', updateStatus);
      ;['dragenter','dragover'].forEach(ev => wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add('is-drag'); }));
      ;['dragleave','drop'].forEach(ev => wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.remove('is-drag'); }));
      wrap.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files;
        if (f && f.length) {
          try {
            const dt = new DataTransfer();
            for (let i = 0; i < f.length; i++) dt.items.add(f[i]);
            input.files = dt.files;
          } catch (_) {}
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    },
  };

  const NPSticky = {
    bind(table) { if (table) table.classList.add('np-sticky-head'); },
  };

  // Click-to-enlarge for any profile photo (doctor avatars in Admin's
  // doctor grid/insights drawer, the Doctor portal's own header/profile
  // photo, etc.) — one shared lightbox instead of a bespoke modal per page.
  let _lightboxHost = null;
  const NPLightbox = {
    open(url, alt) {
      if (!url) return;
      this.close();
      injectStyles();
      const host = document.createElement('div');
      host.className = 'np-lightbox';
      host.setAttribute('role', 'dialog');
      host.setAttribute('aria-modal', 'true');
      host.innerHTML =
        '<button type="button" class="np-lightbox__close" aria-label="Close">&times;</button>' +
        '<img class="np-lightbox__img" src="' + String(url).replace(/"/g, '&quot;') + '" alt="' + String(alt || '').replace(/"/g, '&quot;') + '"/>';
      host.addEventListener('click', (e) => { if (e.target === host) this.close(); });
      host.querySelector('.np-lightbox__close').addEventListener('click', () => this.close());
      document.addEventListener('keydown', this._onKey);
      document.body.appendChild(host);
      requestAnimationFrame(() => host.classList.add('is-visible'));
      _lightboxHost = host;
    },
    close() {
      if (!_lightboxHost) return;
      const host = _lightboxHost; _lightboxHost = null;
      document.removeEventListener('keydown', NPLightbox._onKey);
      host.classList.remove('is-visible');
      setTimeout(() => host.remove(), 150);
    },
    _onKey(e) { if (e.key === 'Escape') NPLightbox.close(); },
  };

  // Notification bell shared by all 4 portals. Each portal already has its
  // own authenticated api() helper (baked-in Bearer token) — this component
  // doesn't know or care about auth, it just calls api(basePath + '/...').
  function notifEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function notifTimeAgo(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  const NPNotifications = {
    _timer: null,
    mount(container, api, opts) {
      if (!container) return;
      injectStyles();
      opts = opts || {};
      const base = opts.basePath || '';
      const pollMs = opts.pollMs || 45000;

      container.innerHTML =
        '<div class="np-notif">' +
          '<button type="button" class="np-notif__btn" aria-label="Notifications">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>' +
            '<span class="np-notif__dot" style="display:none">0</span>' +
          '</button>' +
          '<div class="np-notif__panel">' +
            '<div class="np-notif__head"><span>Notifications</span><button type="button" class="np-notif__markall">Mark all read</button></div>' +
            '<div class="np-notif__list"><div class="np-notif__empty">Loading…</div></div>' +
          '</div>' +
        '</div>';

      const btn      = container.querySelector('.np-notif__btn');
      const dot      = container.querySelector('.np-notif__dot');
      const panel    = container.querySelector('.np-notif__panel');
      const list     = container.querySelector('.np-notif__list');
      const markAll  = container.querySelector('.np-notif__markall');

      async function refreshCount() {
        try {
          const r = await api(base + '/my-notifications/unread-count');
          const n = (r && r.count) || 0;
          if (n > 0) { dot.style.display = ''; dot.textContent = n > 99 ? '99+' : String(n); }
          else dot.style.display = 'none';
        } catch (_) {}
      }

      // The bell is a lightweight "what's new" indicator, not a history —
      // a full permanent record already exists elsewhere (the audit /
      // delivery logs). So it only ever lists UNREAD notifications, and
      // reading one (individually or via "mark all") removes it from the
      // list outright instead of just toggling a read/unread style — that
      // half-state ("marked read but still sitting right there") is what
      // read as "mark all as read doesn't make it disappear".
      function noteEmptyIfNeeded() {
        if (!list.querySelector('.np-notif__item')) {
          list.innerHTML = '<div class="np-notif__empty">No notifications yet.</div>';
        }
      }

      async function loadList() {
        list.innerHTML = '<div class="np-notif__empty">Loading…</div>';
        try {
          const rows = await api(base + '/my-notifications?unreadOnly=1');
          if (!rows.length) { list.innerHTML = '<div class="np-notif__empty">No notifications yet.</div>'; return; }
          list.innerHTML = rows.map(n =>
            '<button type="button" class="np-notif__item is-unread" data-id="' + n.id + '">' +
              '<div class="np-notif__item-title"><span class="np-notif__item-dot"></span>' + notifEsc(n.title) + '</div>' +
              '<div class="np-notif__item-msg">' + notifEsc(n.message) + '</div>' +
              '<div class="np-notif__item-time">' + notifTimeAgo(n.createdAt) + '</div>' +
            '</button>'
          ).join('');
          list.querySelectorAll('.np-notif__item').forEach(el => {
            el.addEventListener('click', async () => {
              el.remove();
              noteEmptyIfNeeded();
              try { await api(base + '/my-notifications/' + el.dataset.id + '/read', { method: 'POST' }); } catch (_) {}
              refreshCount();
            });
          });
        } catch (_) {
          list.innerHTML = '<div class="np-notif__empty">Could not load notifications.</div>';
        }
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = panel.classList.toggle('is-open');
        if (open) {
          // Only the mobile (position:fixed) layout needs a JS-computed
          // top — desktop's position:absolute already sits correctly via
          // top:calc(100% + 8px) in the stylesheet, and overwriting that
          // with a viewport-relative value would misplace it there.
          if (window.matchMedia('(max-width:600px)').matches) {
            panel.style.top = (btn.getBoundingClientRect().bottom + 8) + 'px';
          } else {
            panel.style.top = '';
          }
          loadList();
        }
      });
      markAll.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await api(base + '/my-notifications/read-all', { method: 'POST' }); loadList(); refreshCount(); } catch (_) {}
      });
      panel.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', () => panel.classList.remove('is-open'));

      refreshCount();
      if (NPNotifications._timer) clearInterval(NPNotifications._timer);
      NPNotifications._timer = setInterval(refreshCount, pollMs);
    }
  };

  // Shared "fancy" tooltip for the small revenue/count sparklines used on
  // every dashboard (admin/doctor/receptionist/pharmacy). Replaces the
  // plain OS tooltip a bare title="" attribute gives you, and — critically
  // — separates "show me what this bar means" from "navigate away": a tap
  // pins the tooltip open with an explicit link inside it, so touch users
  // get a chance to read the value before deciding to drill in. A bar
  // opts in with data-tt-title/data-tt-value/data-tt-link/data-tt-onclick
  // instead of title/onclick.
  const NPSparkTooltip = {
    _el: null,
    _pinnedBar: null,
    _bound: new WeakSet(),
    _ensureEl() {
      injectStyles();
      if (this._el) return this._el;
      const el = document.createElement('div');
      el.className = 'np-spark-tooltip';
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
      el.addEventListener('click', (e) => {
        const link = e.target.closest('.np-spark-tooltip__link');
        if (link && link.dataset.onclick) {
          try { new Function(link.dataset.onclick)(); } catch (_) {}
          this.hide();
        }
      });
      this._el = el;
      return el;
    },
    show(bar, { pin = false } = {}) {
      const el = this._ensureEl();
      const title = bar.getAttribute('data-tt-title') || '';
      const value = bar.getAttribute('data-tt-value') || '';
      const linkLabel = bar.getAttribute('data-tt-link') || '';
      const onclick = bar.getAttribute('data-tt-onclick') || '';
      el.innerHTML =
        (title ? '<div class="np-spark-tooltip__title"></div>' : '') +
        (value ? '<div class="np-spark-tooltip__value"></div>' : '') +
        (pin && linkLabel ? '<button type="button" class="np-spark-tooltip__link"></button>' : '');
      const titleEl = el.querySelector('.np-spark-tooltip__title');
      if (titleEl) titleEl.textContent = title;
      const valueEl = el.querySelector('.np-spark-tooltip__value');
      if (valueEl) valueEl.textContent = value;
      const linkEl = el.querySelector('.np-spark-tooltip__link');
      if (linkEl) { linkEl.textContent = linkLabel; linkEl.dataset.onclick = onclick; }

      el.classList.add('is-visible');
      el.classList.toggle('is-pinned', pin);

      const barBox = bar.getBoundingClientRect();
      const ttWidth = el.offsetWidth || 160;
      const ttHeight = el.offsetHeight || 50;
      let left = barBox.left + barBox.width / 2 - ttWidth / 2;
      left = Math.max(8, Math.min(window.innerWidth - ttWidth - 8, left));
      let top = barBox.top - ttHeight - 10;
      if (top < 4) top = barBox.bottom + 10; // flip below if no room above
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    },
    hide() {
      if (!this._el) return;
      this._el.classList.remove('is-visible', 'is-pinned');
      this._pinnedBar = null;
    },
    // Idempotent — safe to call every time a sparkline is re-rendered.
    bind(container) {
      if (!container || this._bound.has(container)) return;
      this._bound.add(container);
      container.addEventListener('pointerenter', (e) => {
        const bar = e.target.closest('.np-sparkline__bar[data-tt-title]');
        if (bar && !this._pinnedBar && e.pointerType !== 'touch') this.show(bar, { pin: false });
      }, true);
      container.addEventListener('pointerleave', (e) => {
        const bar = e.target.closest('.np-sparkline__bar[data-tt-title]');
        if (bar && !this._pinnedBar) this.hide();
      }, true);
      container.addEventListener('click', (e) => {
        const bar = e.target.closest('.np-sparkline__bar[data-tt-title]');
        if (!bar) return;
        e.preventDefault();
        if (this._pinnedBar === bar) { this.hide(); return; }
        this._pinnedBar = bar;
        this.show(bar, { pin: true });
      });
      if (!NPSparkTooltip._docBound) {
        NPSparkTooltip._docBound = true;
        document.addEventListener('click', (e) => {
          if (!this._pinnedBar) return;
          if (e.target.closest('.np-spark-tooltip') || e.target.closest('.np-sparkline__bar[data-tt-title]')) return;
          this.hide();
        });
      }
    }
  };

  // Generic version of Admin's rich SVG daily-trend chart (gridlines, peak
  // highlight, average line, hover/tap tooltip with a drill-down link) so
  // Doctor/Receptionist/Pharmacy can have the same chart instead of only
  // the flat sparkline. Admin keeps its own original implementation
  // untouched (proven, iterated on already) — this is a fresh, parallel
  // copy adapted to take field-access callbacks instead of hardcoded
  // total/completed/revenue property names, since each portal's per-day
  // bucket shape differs (appointments+completed+revenue for doctor,
  // appointments+collected for receptionist, bills+collected for pharmacy).
  const NPDailyChart = {
    _state: {},
    render(elId, data, opts) {
      injectStyles();
      const wrap = document.getElementById(elId);
      if (!wrap) return;
      this._state[elId] = { data: data || [], opts: opts || {} };
      this._draw(elId);
      const st = this._state[elId];
      if (!st.resizeObs) {
        if ('ResizeObserver' in window) {
          let lastW = Math.round(wrap.getBoundingClientRect().width);
          st.resizeObs = new ResizeObserver(entries => {
            const w = Math.round(entries[0].contentRect.width);
            if (Math.abs(w - lastW) < 4) return;
            lastW = w;
            this._draw(elId);
          });
          st.resizeObs.observe(wrap);
        } else {
          st.resizeObs = true;
          window.addEventListener('resize', () => this._draw(elId));
        }
      }
    },
    _draw(elId) {
      const wrap = document.getElementById(elId);
      const st = this._state[elId];
      if (!wrap || !st) return;
      const { data, opts } = st;
      const getTotal = opts.getTotal || (d => Number(d.total) || 0);
      const unitWord = opts.unitLabel || ((n) => n === 1 ? 'item' : 'items');
      const tooltipMain = opts.tooltipMain || ((d, total) => total + ' ' + unitWord(total));
      const tooltipSub = opts.tooltipSub || (() => '');
      const linkLabel = opts.linkLabel || '';
      const onDayClick = opts.onDayClick || (() => {});
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

      if (!data.length) {
        wrap.innerHTML = '<div class="np-empty" style="padding:2rem 0;"><div class="np-empty__sub">' + esc(opts.emptyText || 'No data yet.') + '</div></div>';
        return;
      }

      const containerW = Math.max(240, Math.round(wrap.getBoundingClientRect().width) || 600);
      const isNarrow = containerW < 460;
      const W = containerW;
      const H = isNarrow ? 220 : 290;
      const marginTop = 28;
      const marginRight = isNarrow ? 8 : 14;
      const marginBottom = isNarrow ? 34 : 38;

      const maxRaw = Math.max(0, ...data.map(d => getTotal(d)));
      const stepsCount = 4;
      const niceMax = Math.max(stepsCount, Math.ceil(maxRaw / stepsCount) * stepsCount);
      const stepVal = niceMax / stepsCount;
      const marginLeft = Math.min(50, Math.max(24, 14 + String(niceMax).length * 8));

      const plotW = Math.max(10, W - marginLeft - marginRight);
      const plotH = H - marginTop - marginBottom;
      const n = data.length;
      const band = plotW / n;
      const barW = Math.max(isNarrow ? 4 : 6, Math.min(isNarrow ? 12 : 18, band * 0.38));

      const avg = data.reduce((s, d) => s + getTotal(d), 0) / data.length;
      const peakIdx = data.reduce((best, d, i) => getTotal(d) > getTotal(data[best]) ? i : best, 0);
      const peakVal = getTotal(data[peakIdx]);

      let gridLines = '', yLabels = '';
      for (let s = 0; s <= stepsCount; s++) {
        const val = Math.round(stepVal * s);
        const y = marginTop + plotH - (val / niceMax) * plotH;
        gridLines += '<line class="np-chart__grid" x1="' + marginLeft + '" x2="' + (W - marginRight).toFixed(1) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"></line>';
        yLabels += '<text class="np-chart__ylabel" x="' + (marginLeft - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + val + '</text>';
      }

      let avgLine = '';
      if (peakVal > 0 && avg > 0.15) {
        const yAvg = marginTop + plotH - (avg / niceMax) * plotH;
        const avgText = avg % 1 === 0 ? String(avg) : avg.toFixed(1);
        const avgLabelY = Math.max(marginTop + 8, yAvg - 5);
        avgLine = '<line class="np-chart__avgline" x1="' + marginLeft + '" x2="' + (W - marginRight).toFixed(1) + '" y1="' + yAvg.toFixed(1) + '" y2="' + yAvg.toFixed(1) + '"></line>' +
          '<text class="np-chart__avglabel" x="' + (W - marginRight).toFixed(1) + '" y="' + avgLabelY.toFixed(1) + '" text-anchor="end">avg ' + avgText + '</text>';
      }

      const minLabelBand = 34;
      const labelEvery = band < minLabelBand ? 2 : 1;

      let bars = '', xlabels = '';
      let lastMonth = null;
      data.forEach((d, i) => {
        const total = getTotal(d);
        const cx = marginLeft + band * i + band / 2;
        const h = total > 0 ? Math.max(3, (total / niceMax) * plotH) : 2;
        const y = marginTop + plotH - h;
        const isPeak = i === peakIdx && total > 0;
        const isToday = i === data.length - 1;
        const barCls = total === 0
          ? 'np-chart__bar np-chart__bar--muted'
          : (isPeak ? 'np-chart__bar np-chart__bar--peak' : 'np-chart__bar');

        const dt = new Date(d.date + 'T00:00:00');
        const dayNum = dt.getDate();
        const monthAbbr = dt.toLocaleDateString('en-IN', { month: 'short' });
        const weekday = dt.toLocaleDateString('en-IN', { weekday: 'short' });
        const showMonth = lastMonth !== monthAbbr;
        lastMonth = monthAbbr;

        bars += '<g class="np-chart__col' + (isToday ? ' np-chart__col--today' : '') + '" data-i="' + i + '" tabindex="0" role="img" ' +
          'aria-label="' + esc(weekday) + ', ' + dayNum + ' ' + esc(monthAbbr) + ': ' + esc(tooltipMain(d, total)) + (isToday ? ' (today)' : '') + '">' +
          '<rect class="np-chart__hit" x="' + (cx - band / 2).toFixed(1) + '" y="' + marginTop + '" width="' + band.toFixed(1) + '" height="' + plotH.toFixed(1) + '"></rect>' +
          '<rect class="' + barCls + '" x="' + (cx - barW / 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="' + Math.min(4, barW / 2).toFixed(1) + '"></rect>' +
          (isPeak ? '<text class="np-chart__peaklabel" x="' + cx.toFixed(1) + '" y="' + (y - 8).toFixed(1) + '" text-anchor="middle">' + total + '</text>' : '') +
          '</g>';

        const forceShow = isToday || i === 0;
        if (forceShow || i % labelEvery === 0) {
          xlabels += '<text class="np-chart__xlabel' + (isToday ? ' np-chart__xlabel--today' : '') + '" x="' + cx.toFixed(1) + '" y="' + (H - marginBottom + 16).toFixed(1) + '" text-anchor="middle">' + (showMonth ? esc(monthAbbr) + ' ' : '') + dayNum + '</text>';
        }
      });

      const peakDateLabel = esc(new Date(data[peakIdx].date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));

      wrap.innerHTML =
        '<svg class="np-chart__svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-label="Daily trend for the last ' + n + ' days">' +
          '<g class="np-chart__grid-group">' + gridLines + '</g>' +
          '<g class="np-chart__bars">' + bars + '</g>' +
          avgLine +
          '<g class="np-chart__ylabels">' + yLabels + '</g>' +
          '<g class="np-chart__xlabels">' + xlabels + '</g>' +
          '<line class="np-chart__axis" x1="' + marginLeft + '" x2="' + (W - marginRight).toFixed(1) + '" y1="' + (marginTop + plotH).toFixed(1) + '" y2="' + (marginTop + plotH).toFixed(1) + '"></line>' +
        '</svg>' +
        '<div class="np-chart__tooltip" id="' + elId + 'Tooltip" role="tooltip" aria-hidden="true"></div>' +
        '<div class="np-chart__legend">' +
          '<span class="np-chart__legend-item"><i class="np-chart__legend-swatch"></i>' + esc(opts.legendLabel || 'Volume') + '</span>' +
          (peakVal > 0 ? '<span class="np-chart__legend-item"><i class="np-chart__legend-swatch np-chart__legend-swatch--peak"></i>Busiest day</span>' +
          '<span class="np-chart__legend-item np-chart__legend-note">Peak: ' + peakVal + ' on ' + peakDateLabel + '</span>' : '') +
        '</div>';

      this._bind(elId);
    },
    _bind(elId) {
      const wrap = document.getElementById(elId);
      const st = this._state[elId];
      if (!wrap || !st) return;
      const { data, opts } = st;
      const getTotal = opts.getTotal || (d => Number(d.total) || 0);
      const unitWord = opts.unitLabel || ((n) => n === 1 ? 'item' : 'items');
      const tooltipMain = opts.tooltipMain || ((d, total) => total + ' ' + unitWord(total));
      const tooltipSub = opts.tooltipSub || (() => '');
      const linkLabel = opts.linkLabel || '';
      const onDayClick = opts.onDayClick || (() => {});
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

      const svg = wrap.querySelector('.np-chart__svg');
      const tooltip = wrap.querySelector('.np-chart__tooltip');
      if (!svg || !tooltip) return;
      let pinned = null;

      function contentFor(i) {
        const d = data[i]; if (!d) return '';
        const dt = new Date(d.date + 'T00:00:00');
        const label = dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
        const total = getTotal(d);
        const sub = tooltipSub(d, total);
        return '<div class="np-chart__tooltip-date">' + esc(label) + '</div>' +
          '<div class="np-chart__tooltip-main">' + esc(tooltipMain(d, total)) + '</div>' +
          (sub ? '<div class="np-chart__tooltip-sub">' + esc(sub) + '</div>' : '') +
          (total > 0 && linkLabel ? '<button type="button" class="np-chart__tooltip-link" data-date="' + esc(d.date) + '">' + esc(linkLabel) + '</button>' : '');
      }
      function show(i, col) {
        const rect = col.querySelector('rect:nth-child(2)');
        if (!rect) return;
        tooltip.innerHTML = contentFor(i);
        tooltip.classList.add('is-visible');
        tooltip.setAttribute('aria-hidden', 'false');
        const barBox = rect.getBoundingClientRect();
        const wrapBox = wrap.getBoundingClientRect();
        let left = barBox.left - wrapBox.left + barBox.width / 2;
        const top = barBox.top - wrapBox.top;
        const ttWidth = tooltip.offsetWidth || 160;
        const minLeft = ttWidth / 2 + 4;
        const maxLeft = wrapBox.width - ttWidth / 2 - 4;
        left = Math.max(minLeft, Math.min(maxLeft, left));
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
        Array.from(svg.querySelectorAll('.np-chart__col')).forEach(c => c.classList.toggle('is-active', c === col));
      }
      function hide() {
        tooltip.classList.remove('is-visible', 'is-pinned');
        tooltip.setAttribute('aria-hidden', 'true');
        Array.from(svg.querySelectorAll('.np-chart__col')).forEach(c => c.classList.remove('is-active'));
        pinned = null;
      }
      svg.addEventListener('pointermove', (e) => {
        if (pinned != null || e.pointerType === 'touch') return;
        const col = e.target.closest('.np-chart__col');
        if (col) show(Number(col.dataset.i), col); else hide();
      });
      svg.addEventListener('pointerleave', () => { if (pinned == null) hide(); });
      svg.addEventListener('click', (e) => {
        const col = e.target.closest('.np-chart__col');
        if (!col) { hide(); return; }
        const i = Number(col.dataset.i);
        if (pinned === i) { hide(); return; }
        pinned = i;
        show(i, col);
        tooltip.classList.add('is-pinned');
      });
      tooltip.addEventListener('click', (e) => {
        const link = e.target.closest('.np-chart__tooltip-link');
        if (link && link.dataset.date) onDayClick(link.dataset.date);
      });
      svg.addEventListener('focusin', (e) => {
        const col = e.target.closest('.np-chart__col');
        if (col) show(Number(col.dataset.i), col);
      });
      svg.addEventListener('focusout', (e) => {
        if (pinned == null && !svg.contains(e.relatedTarget)) hide();
      });
      document.addEventListener('click', (e) => {
        if (pinned != null && !wrap.contains(e.target)) hide();
      });
    }
  };

  global.NPTheme      = NPTheme;
  global.NPPalette    = NPPalette;
  global.NPChips      = NPChips;
  global.NPDateRange  = NPDateRange;
  global.NPDropzone   = NPDropzone;
  global.NPSticky     = NPSticky;
  global.NPDatePicker = NPDatePicker;
  global.NPLightbox   = NPLightbox;
  global.NPNotifications = NPNotifications;
  global.NPSparkTooltip  = NPSparkTooltip;
  global.NPDailyChart    = NPDailyChart;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { NPTheme.init(); NPDatePicker.init(); });
  } else {
    NPTheme.init();
    NPDatePicker.init();
  }
})(window);

// Mobile back-button support for modals/drawers, shared by all 4 portals.
// Every portal opens a `.np-modal`/`.np-drawer` the same way (remove the
// `hidden` class) but each has its own bespoke open/close functions — there
// is no single shared open()/close() call to hook. Rather than touching
// every call site, this watches the DOM directly: opening one of these
// elements pushes a throwaway history entry, so the phone's hardware/
// gesture back button closes the topmost open modal instead of leaving the
// page entirely; closing it any other way (X button, Cancel, submit)
// consumes that same entry so a later back press doesn't need pressing
// twice to actually leave.
(function () {
  'use strict';
  var openStack = [];
  var closingViaPopstate = false;

  function isModalLike(el) {
    return !!(el && el.classList && (el.classList.contains('np-modal') || el.classList.contains('np-drawer')));
  }

  function onToggle(el) {
    if (!isModalLike(el)) return;
    var isHidden = el.classList.contains('hidden');
    var idx = openStack.indexOf(el);
    if (!isHidden && idx === -1) {
      openStack.push(el);
      try { history.pushState({ npModalDepth: openStack.length }, ''); } catch (_) {}
    } else if (isHidden && idx !== -1) {
      openStack.splice(idx, 1);
      if (!closingViaPopstate) {
        try { history.back(); } catch (_) {}
      }
    }
  }

  window.addEventListener('popstate', function () {
    if (!openStack.length) return;
    closingViaPopstate = true;
    var el = openStack[openStack.length - 1];
    el.classList.add('hidden');
    Promise.resolve().then(function () { closingViaPopstate = false; });
  });

  function startObserving() {
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'attributes' && m.attributeName === 'class') onToggle(m.target);
        }
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }
})();

