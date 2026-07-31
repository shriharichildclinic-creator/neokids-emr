
(function (global) {
  'use strict';
  if (global.NPToast && global.NPModal) return; // idempotent

  const CSS = `
  .np-ui-toast-host{position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:10px;max-width:min(420px,calc(100vw - 32px));pointer-events:none}
  @media (max-width:480px){.np-ui-toast-host{top:auto;bottom:16px;left:16px;right:16px;max-width:none}}
  .np-ui-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:10px;background:#fff;color:#111827;box-shadow:0 10px 25px rgba(0,0,0,.12),0 2px 6px rgba(0,0,0,.08);border-left:4px solid #6b7280;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;opacity:0;transform:translateX(20px);transition:opacity .22s ease,transform .22s ease;will-change:opacity,transform}
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
  .np-ui-modal{background:#fff;border-radius:14px;box-shadow:0 25px 50px -12px rgba(0,0,0,.35);max-width:440px;width:100%;padding:22px;font:500 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;transform:scale(.96);transition:transform .18s ease}
  .np-ui-modal-host.is-visible .np-ui-modal{transform:scale(1)}
  .np-ui-modal__title{font-size:17px;font-weight:700;margin:0 0 8px;color:#0f172a}
  .np-ui-modal__message{color:#374151;margin:0 0 16px;white-space:pre-wrap}
  .np-ui-modal__input{display:block;width:100%;padding:9px 11px;border:1px solid #d1d5db;border-radius:8px;font:inherit;color:inherit;outline:none;margin-bottom:14px;box-sizing:border-box}
  .np-ui-modal__input:focus{border-color:#89BCBD;box-shadow:0 0 0 3px rgba(137,188,189,.15)}
  .np-ui-modal__actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
  .np-ui-modal__btn{padding:8px 16px;border-radius:8px;font:600 14px/1 inherit;cursor:pointer;border:1px solid transparent;background:transparent;color:#374151}
  .np-ui-modal__btn:hover{background:#f3f4f6}
  .np-ui-modal__btn--primary{background:#89BCBD;color:#fff;border-color:#89BCBD}
  .np-ui-modal__btn--primary:hover{background:#5A9495;border-color:#5A9495}
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
  .np-palette{width:100%;max-width:560px;background:#fff;border-radius:14px;box-shadow:0 25px 50px -12px rgba(0,0,0,.4);overflow:hidden;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827}
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

.np-sticky-head thead th{position:sticky;top:0;z-index:5;background:inherit}
  `;

  function injectStyles() {
    if (document.getElementById('np-ux-styles')) return;
    const s = document.createElement('style');
    s.id = 'np-ux-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const NPTheme = {
    init() {
      injectStyles();
      const saved = (function () { try { return localStorage.getItem('np-theme'); } catch (_) { return null; } })();
      const dark = saved
        ? saved === 'dark'
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      this.set(dark ? 'dark' : 'light');

      if (!document.getElementById('np-theme-toggle')) {
        const btn = document.createElement('button');
        btn.id = 'np-theme-toggle';
        btn.type = 'button';
        btn.className = 'np-theme-toggle';
        btn.setAttribute('aria-label', 'Toggle dark mode');
        btn.title = 'Toggle dark mode (D)';
        btn.textContent = dark ? '☀' : '🌙';
        btn.addEventListener('click', () => NPTheme.toggle());
        document.body.appendChild(btn);
      }
    },
    set(mode) {
      document.documentElement.setAttribute('data-theme', mode);
      try { localStorage.setItem('np-theme', mode); } catch (_) {}
      const btn = document.getElementById('np-theme-toggle');
      if (btn) btn.textContent = mode === 'dark' ? '☀' : '🌙';
    },
    toggle() {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      this.set(cur === 'dark' ? 'light' : 'dark');
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

      function updateStatus() {
        const f = input.files && input.files[0];
        status.textContent = f ? ('Selected: ' + f.name + ' (' + Math.round(f.size / 1024) + ' KB)') : '';
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

  global.NPTheme     = NPTheme;
  global.NPPalette   = NPPalette;
  global.NPChips     = NPChips;
  global.NPDateRange = NPDateRange;
  global.NPDropzone  = NPDropzone;
  global.NPSticky    = NPSticky;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => NPTheme.init());
  } else {
    NPTheme.init();
  }
})(window);

