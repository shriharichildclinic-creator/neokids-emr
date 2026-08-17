// whatsapp.service.js — Bug 4 hardened version
// =====================================================================
// Changes vs previous:
//   1. Returns rich structured errors (errorCode, errorTitle, errorDetail)
//      so the caller can log WHY a send failed, not just "FAILED".
//   2. Phone normalization is centralized and matches India (+91) but the
//      "auto-prepend 91" only triggers when the number is exactly 10 digits.
//      Previously a 12-digit number starting with "01" became "9101..." -
//      now caught.
//   3. Component builder always emits the URL button (sub_type=url, index=0)
//      when urlButtonParam is provided — Meta rejects the request if the
//      template defines a URL button but the request omits it.
//   4. New sendPlainText() helper for the 24h customer-care window, used as
//      a fallback by the rescheduler if Meta says "template_not_found".
//   5. New sendWhatsAppWithFallback() — tries the primary template, and if
//      Meta returns code 132001/132012 (template not found / param mismatch),
//      falls back to the optional fallback template, then plain text.
// =====================================================================

const logger = require('../utils/logger');

const PROVIDER = (process.env.WA_PROVIDER || 'MOCK').toUpperCase();
const WA_LANG  = process.env.META_LANG_CODE || 'en';

// ─── Phone normalization ───
function normalizePhone(to) {
  const digits = String(to || '').replace(/\D/g, '');
  if (!digits) throw new Error('Phone number is empty');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  // anything else — return as-is and let Meta reject
  return digits;
}

// ─── Component builder ───
function buildComponents({ bodyParams = [], urlButtonParam = null, headerParams = [] }) {
  const components = [];
  if (headerParams && headerParams.length) {
    components.push({
      type: 'header',
      parameters: headerParams.map(t => ({ type: 'text', text: String(t ?? '') }))
    });
  }
  if (bodyParams && bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map(t => ({ type: 'text', text: String(t ?? '') }))
    });
  }
  if (urlButtonParam !== null && urlButtonParam !== undefined && urlButtonParam !== '') {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(urlButtonParam) }]
    });
  }
  return components;
}

// ─── Low-level Meta sender ───
async function sendViaMeta({ to, templateName, components = [] }) {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token   = process.env.META_ACCESS_TOKEN;
  if (!phoneId || !token) {
    const e = new Error('META_PHONE_NUMBER_ID or META_ACCESS_TOKEN missing');
    e.code = 'META_CONFIG_MISSING';
    throw e;
  }
  if (!templateName) {
    const e = new Error('templateName is required for Meta WhatsApp');
    e.code = 'META_TEMPLATE_MISSING';
    throw e;
  }

  const formatted = normalizePhone(to);

  const body = {
    messaging_product: 'whatsapp',
    to: formatted,
    type: 'template',
    template: { name: templateName, language: { code: WA_LANG }, components }
  };

  const res  = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Meta API error (${res.status})`);
    err.code        = data?.error?.code || 'META_HTTP_ERROR';
    err.subcode     = data?.error?.error_subcode;
    err.title       = data?.error?.error_user_title;
    err.detail      = data?.error?.error_user_msg;
    err.fbTraceId   = data?.error?.fbtrace_id;
    err.httpStatus  = res.status;
    err.raw         = data;
    logger.error(`[META] template=${templateName} to=${formatted} code=${err.code} msg="${err.message}"`);
    throw err;
  }
  logger.info(`[META] Sent "${templateName}" to ${formatted} (msgid=${data?.messages?.[0]?.id || '?'})`);
  return data;
}

// ─── Plain text (only works inside the 24h customer-care window) ───
async function sendViaMetaText({ to, body }) {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token   = process.env.META_ACCESS_TOKEN;
  if (!phoneId || !token) throw new Error('META credentials missing');
  const formatted = normalizePhone(to);
  const payload = {
    messaging_product: 'whatsapp',
    to: formatted,
    type: 'text',
    text: { body: String(body).slice(0, 4096) }
  };
  const res  = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || 'Meta plain-text send failed');
    err.code = data?.error?.code || 'META_HTTP_ERROR';
    err.raw  = data;
    throw err;
  }
  logger.info(`[META-TEXT] Sent plain message to ${formatted}`);
  return data;
}

/**
 * Standard send. Returns the Meta response on success, throws on failure.
 */
async function sendWhatsApp({ to, templateName, bodyParams, urlButtonParam, headerParams, body }) {
  try {
    if (PROVIDER === 'META') {
      const components = buildComponents({ bodyParams, urlButtonParam, headerParams });
      return await sendViaMeta({ to, templateName, components });
    }
    logger.info(`[WA-MOCK] To ${to} | tpl=${templateName} | params=${JSON.stringify(bodyParams)} | btn=${urlButtonParam || '-'} | body="${body || ''}"`);
    return { sid: 'mock_' + Date.now(), status: 'mock' };
  } catch (err) {
    logger.error(`[WA-${PROVIDER}] Failed to ${to}: ${err.message}`);
    throw err;
  }
}

/**
 * Bug 4 — Tries primary → fallback template → plain text (24h window).
 * Returns { ok, via, error? }.
 *   - via: 'primary' | 'fallback' | 'text' | 'mock' | 'skipped'
 *   - error: structured error from the LAST failed attempt (if any)
 *
 * Codes recognized as "swap to fallback":
 *   132000 — Number of parameters does not match expected
 *   132001 — Template does not exist
 *   132005 — Translated text too long
 *   132007 — Template format is incorrect
 *   132012 — Param format mismatch
 *   100    — Invalid parameter (often: template missing or component shape wrong)
 */
const TEMPLATE_FAILURE_CODES = new Set([100, 132000, 132001, 132005, 132007, 132012]);

async function sendWhatsAppWithFallback({
  to,
  primaryTemplate,
  fallbackTemplate,
  bodyParams,
  urlButtonParam,
  headerParams,
  plainTextFallback
}) {
  let lastError = null;

  // MOCK provider — skip everything but pretend it worked.
  if (PROVIDER !== 'META') {
    await sendWhatsApp({ to, templateName: primaryTemplate, bodyParams, urlButtonParam, headerParams });
    return { ok: true, via: 'mock' };
  }

  // 1. Primary template
  try {
    const r = await sendViaMeta({
      to, templateName: primaryTemplate,
      components: buildComponents({ bodyParams, urlButtonParam, headerParams })
    });
    return { ok: true, via: 'primary', response: r };
  } catch (e) {
    lastError = e;
    const swap = TEMPLATE_FAILURE_CODES.has(Number(e.code));
    if (!swap || !fallbackTemplate) {
      // Try the plain-text final fallback even on non-template errors when text is provided.
      if (plainTextFallback) {
        try {
          const r = await sendViaMetaText({ to, body: plainTextFallback });
          return { ok: true, via: 'text', response: r, primaryError: serializeWaError(e) };
        } catch (e2) {
          lastError = e2;
        }
      }
      return { ok: false, via: 'primary', error: serializeWaError(lastError) };
    }
  }

  // 2. Fallback template
  if (fallbackTemplate) {
    try {
      const r = await sendViaMeta({
        to, templateName: fallbackTemplate,
        components: buildComponents({ bodyParams, urlButtonParam, headerParams })
      });
      return { ok: true, via: 'fallback', response: r, primaryError: serializeWaError(lastError) };
    } catch (e) {
      lastError = e;
    }
  }

  // 3. Plain text (only inside 24h customer-care window)
  if (plainTextFallback) {
    try {
      const r = await sendViaMetaText({ to, body: plainTextFallback });
      return { ok: true, via: 'text', response: r, primaryError: serializeWaError(lastError) };
    } catch (e) {
      lastError = e;
    }
  }

  return { ok: false, via: 'none', error: serializeWaError(lastError) };
}

function serializeWaError(e) {
  if (!e) return null;
  return {
    message: e.message,
    code:    e.code,
    subcode: e.subcode,
    title:   e.title,
    detail:  e.detail,
    httpStatus: e.httpStatus,
    fbTraceId:  e.fbTraceId
  };
}

module.exports = {
  sendWhatsApp,
  sendWhatsAppWithFallback,
  buildComponents,
  normalizePhone
};