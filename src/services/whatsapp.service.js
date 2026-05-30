const logger = require('../utils/logger');

const PROVIDER = (process.env.WA_PROVIDER || 'MOCK').toUpperCase();

async function sendViaMeta({ to, templateName = 'hello_world', components = [] }) {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token   = process.env.META_ACCESS_TOKEN;

  if (!phoneId || !token) {
    logger.warn('[META] Missing META_PHONE_NUMBER_ID or META_ACCESS_TOKEN');
    return null;
  }

  // Format: remove +, spaces, leading 91 then re-add 91
  const digits    = to.replace(/\D/g, '');
  const formatted = digits.startsWith('91') ? digits : `91${digits}`;

  const body = {
    messaging_product: 'whatsapp',
    to: formatted,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en_US' },
      components
    }
  };

  const res  = await fetch(
    `https://graph.facebook.com/v19.0/${phoneId}/messages`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json'
      },
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

async function sendViaBhash({ to, templateName, params = [], mediaUrl = null }) {
  const user   = process.env.BHASH_USER   || 'bhashwapai';
  const pass   = process.env.BHASH_PASS   || 'bwap@1234$';
  const sender = process.env.BHASH_SENDER || 'BUZWAP';

  const formatted = to.replace(/^\+?91/, '').replace(/\D/g, '');

  const url = new URL('https://bhashsms.com/api/sendmsgutil.php');
  url.searchParams.set('user',     user);
  url.searchParams.set('pass',     pass);
  url.searchParams.set('sender',   sender);
  url.searchParams.set('phone',    formatted);
  url.searchParams.set('text',     templateName);
  url.searchParams.set('priority', 'wa');
  url.searchParams.set('stype',    'auth');
  if (params.length) url.searchParams.set('Params', params.join(','));
  if (mediaUrl) {
    url.searchParams.set('htype', 'image');
    url.searchParams.set('url',   mediaUrl);
  }

  const res  = await fetch(url.toString());
  const text = await res.text();
  logger.info(`[BHASH] Sent "${templateName}" to ${formatted}: ${text}`);
  return { response: text };
}

async function sendWhatsApp({ to, body, mediaUrl, templateName, params }) {
  try {
    if (PROVIDER === 'META') {
      const tpl = templateName || process.env.META_DEFAULT_TEMPLATE || 'hello_world';
      return await sendViaMeta({ to, templateName: tpl, components: params || [] });
    }

    if (PROVIDER === 'BHASH') {
      const tpl = templateName || process.env.BHASH_DEFAULT_TEMPLATE || 'authe_bhash';
      return await sendViaBhash({ to, templateName: tpl, params: params || [], mediaUrl });
    }

    // MOCK
    logger.info(`[WA-MOCK] To ${to}: ${body || templateName}`);
    return { sid: 'mock_' + Date.now(), status: 'mock' };

  } catch (err) {
    logger.error(`[WA-${PROVIDER}] Failed for ${to}:`, err.message);
    throw err;
  }
}

module.exports = { sendWhatsApp };