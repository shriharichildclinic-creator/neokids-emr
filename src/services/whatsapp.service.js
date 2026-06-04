const logger = require('../utils/logger');

const PROVIDER = (process.env.WA_PROVIDER || 'MOCK').toUpperCase();
const WA_LANG  = process.env.META_LANG_CODE || 'en'; // your templates are registered in 'en', not 'en_US'

/**
 * Build Meta components from a simple shape:
 *   bodyParams: ['Suresh', 'Anjali Sharma', '12 Jun 2026', '5:30 PM', '500']
 *   urlButtonParam: 'abc-xyz-pqr'   // becomes button index 0, type URL, dynamic suffix
 */
function buildComponents({ bodyParams = [], urlButtonParam = null, headerParams = [] }) {
  const components = [];
  if (headerParams.length) {
    components.push({
      type: 'header',
      parameters: headerParams.map(t => ({ type: 'text', text: String(t) }))
    });
  }
  if (bodyParams.length) {
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

async function sendViaMeta({ to, templateName, components = [] }) {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token   = process.env.META_ACCESS_TOKEN;

  if (!phoneId || !token) {
    logger.warn('[META] Missing META_PHONE_NUMBER_ID or META_ACCESS_TOKEN');
    return null;
  }
  if (!templateName) {
    throw new Error('META provider requires a templateName');
  }

  const digits    = String(to).replace(/\D/g, '');
  const formatted = digits.startsWith('91') ? digits : `91${digits}`;

  const body = {
    messaging_product: 'whatsapp',
    to: formatted,
    type: 'template',
    template: {
      name: templateName,
      language: { code: WA_LANG },
      components
    }
  };

  const res  = await fetch(
    `https://graph.facebook.com/v19.0/${phoneId}/messages`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  const data = await res.json();
  if (!res.ok) {
    logger.error('[META] Failed:', JSON.stringify(data));
    throw new Error(data.error?.message || 'Meta API error');
  }
  logger.info(`[META] Sent "${templateName}" to ${formatted}`);
  return data;
}

/**
 * Send a WhatsApp template message.
 *   sendWhatsApp({
 *     to: '9876543210',
 *     templateName: 'neokids_booking_confirms_offline',
 *     bodyParams: ['Suresh','Anjali Sharma','12 Jun 2026','5:30 PM','500'],
 *     urlButtonParam: '?q=Shri+Hari+Clinic+Pune'
 *   })
 */
async function sendWhatsApp({ to, templateName, bodyParams, urlButtonParam, headerParams, body /* legacy plain text — used only by MOCK */ }) {
  try {
    if (PROVIDER === 'META') {
      const components = buildComponents({ bodyParams, urlButtonParam, headerParams });
      return await sendViaMeta({ to, templateName, components });
    }
    // MOCK (for dev/staging without a Meta WABA)
    logger.info(`[WA-MOCK] To ${to} | tpl=${templateName} | params=${JSON.stringify(bodyParams)} | btn=${urlButtonParam || '-'} | body="${body || ''}"`);
    return { sid: 'mock_' + Date.now(), status: 'mock' };
  } catch (err) {
    logger.error(`[WA-${PROVIDER}] Failed for ${to}:`, err.message);
    throw err;
  }
}

module.exports = { sendWhatsApp, buildComponents };
