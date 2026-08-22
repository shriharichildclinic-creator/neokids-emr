// =====================================================================
// email-brand.service.js — NeoKidsPro branded email shell
// ---------------------------------------------------------------------
// A single, reusable, mobile-responsive email template that every
// automated email in the platform (appointments, payments, prescriptions,
// certificates, vaccination reminders, follow-ups, notifications) wraps
// itself in. This gives every email:
//
//   • Consistent NeoKidsPro branding (logo, colors, typography)
//   • Mobile-first, table-based layout that renders correctly on
//     Gmail, Outlook, Apple Mail, and mobile clients.
//   • A trust-building header + footer with contact info & unsubscribe.
//
// Brand palette — matches the real neokidspro.in / public/assets/neokids-theme.css
// theme (--nk-teal-*, --nk-orange-400, --nk-pink-400), not the unrelated blue
// this file used to hardcode:
//   Primary Teal      #89BCBD   (header band start, buttons, headings)
//   Primary Deep      #5A9495   (header band end / hover CTA)
//   Accent Orange     #F9A945   (soft callouts, kid-friendly touch)
//   Accent Pink       #FE84A4   (secondary accent)
//   Text Dark         #1F2937
//   Text Muted        #6B7280
//   Card BG           #FFFFFF
//   Page BG           #F1F7F7   (light teal tint)
//   Border            #D9E6E6
// =====================================================================

const EMR_BASE = (process.env.EMR_URL || process.env.API_URL || process.env.APP_URL || '').replace(/\/+$/, '');

const BRAND = {
  name:        process.env.CLINIC_NAME || 'NeoKidsPro',
  tagline:     'Pediatric Network of Doctors',
  primaryUrl:  (process.env.NEOKIDS_URL || 'https://neokidspro.in').replace(/\/+$/, ''),
  vaxUrl:      (process.env.VACC_PORTAL_URL || 'https://vaxiclinics.com').replace(/\/+$/, ''),
  supportEmail: process.env.SUPPORT_EMAIL || 'admin@neokidspro.in',
  supportPhone: process.env.SUPPORT_PHONE || '',
  // Absolute URL so the logo renders in every mail client (Gmail/Outlook/
  // Apple Mail all need a real hosted image, not a relative path or a
  // data: URI — many clients strip data: URIs from inbound HTML mail).
  logoUrl: EMR_BASE ? `${EMR_BASE}/assets/logo-neokidspro.png` : '',
  colors: {
    primary:   '#89BCBD',
    primaryDk: '#5A9495',
    accent:    '#F9A945',
    accentPk:  '#FE84A4',
    text:      '#1F2937',
    muted:     '#6B7280',
    card:      '#FFFFFF',
    page:      '#F1F7F7',
    border:    '#D9E6E6',
    warnBg:    '#FFF8E6',
    warnBd:    '#F2E3B3',
    warnTx:    '#6B5B21'
  }
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/**
 * Build a branded email HTML.
 *
 * @param {object} opts
 * @param {string} opts.preheader   Hidden preview text shown in inbox list.
 * @param {string} opts.headline    Big H1 shown in the coloured header.
 * @param {string} opts.subhead     Optional secondary line under headline.
 * @param {string} opts.bodyHtml    Main HTML content (already escaped where needed).
 * @param {object[]} [opts.ctas]    Buttons: [{ label, url, color }]
 * @param {string} [opts.disclaimer] Yellow disclaimer box HTML.
 * @param {string} [opts.footerNote] Extra grey footer text.
 */
function renderBrandedEmail({ preheader = '', headline, subhead = '', bodyHtml, ctas = [], disclaimer = '', footerNote = '' }) {
  const c = BRAND.colors;

  const ctaHtml = (ctas || []).filter(Boolean).map(b => `
    <tr>
      <td align="center" style="padding:8px 0;">
        <a href="${b.url}"
           style="display:inline-block;padding:14px 28px;background:${b.color || c.primary};
                  color:#ffffff;border-radius:10px;text-decoration:none;font-weight:600;
                  font-family:Arial,Helvetica,sans-serif;font-size:15px;letter-spacing:.2px;
                  box-shadow:0 2px 6px rgba(90,148,149,.3);">
          ${esc(b.label)}
        </a>
      </td>
    </tr>`).join('');

  const disclaimerHtml = disclaimer ? `
    <tr>
      <td style="padding:8px 28px 4px;">
        <div style="background:${c.warnBg};border:1px solid ${c.warnBd};border-radius:10px;
                    padding:14px 16px;font-size:13px;line-height:1.55;color:${c.warnTx};
                    font-family:Arial,Helvetica,sans-serif;">
          ${disclaimer}
        </div>
      </td>
    </tr>` : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${esc(headline)}</title>
    <style>
      @media (max-width:600px){
        .np-wrap { width:100% !important; }
        .np-pad  { padding-left:18px !important; padding-right:18px !important; }
        .np-hero-h1 { font-size:22px !important; }
        .np-btn { display:block !important; width:100% !important; }
      }
      a { color: ${c.primaryDk}; }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${c.page};font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${esc(preheader || headline)}
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${c.page};">
      <tr><td align="center" style="padding:24px 12px;">

        <table role="presentation" class="np-wrap" width="600" cellspacing="0" cellpadding="0"
               style="width:600px;max-width:600px;background:${c.card};border-radius:16px;
                      overflow:hidden;border:1px solid ${c.border};
                      box-shadow:0 6px 24px rgba(15,46,58,.08);">

          <!-- Header / Brand bar — white, not the teal gradient the logo used
               to sit on. The logo wordmark's "Neo" text is a pale colour
               meant for a plain background (matches the app icon); it
               washed out to near-illegible on a saturated teal fill. A
               thin teal accent rule underneath keeps the brand colour
               present without competing with the logo. -->
          <tr>
            <td style="background:#ffffff; padding:20px 28px; border-bottom:3px solid ${c.primaryDk};">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="vertical-align:middle;">
                    ${BRAND.logoUrl ? `
                    <img src="${BRAND.logoUrl}" alt="${esc(BRAND.name)}" width="132" height="auto"
                         style="display:block;max-width:132px;width:132px;height:auto;border:0;outline:none;">
                    ` : `
                    <div style="color:${c.text};font-family:Arial,Helvetica,sans-serif;font-size:22px;
                                font-weight:700;letter-spacing:.3px;">
                      ${esc(BRAND.name)}
                    </div>`}
                    <div style="color:${c.primaryDk};font-family:Arial,Helvetica,sans-serif;font-size:12px;
                                font-weight:600;margin-top:6px;">
                      ${esc(BRAND.tagline)}
                    </div>
                  </td>
                  <td align="right" style="color:${c.muted};font-family:Arial,Helvetica,sans-serif;
                                            font-size:12px;vertical-align:middle;">
                    <a href="${BRAND.primaryUrl}" style="color:${c.primaryDk};text-decoration:none;">
                      neokidspro.in
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Hero -->
          <tr>
            <td class="np-pad" style="padding:28px 28px 8px;font-family:Arial,Helvetica,sans-serif;">
              <h1 class="np-hero-h1"
                  style="margin:0 0 6px;color:${c.text};font-size:24px;line-height:1.25;font-weight:700;">
                ${esc(headline)}
              </h1>
              ${subhead ? `<div style="color:${c.muted};font-size:14px;line-height:1.5;">${esc(subhead)}</div>` : ''}
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td class="np-pad" style="padding:16px 28px 4px;color:${c.text};
                                      font-family:Arial,Helvetica,sans-serif;font-size:15px;
                                      line-height:1.6;">
              ${bodyHtml}
            </td>
          </tr>

          ${disclaimerHtml}

          ${ctaHtml ? `
          <tr>
            <td class="np-pad" style="padding:14px 28px 24px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                ${ctaHtml}
              </table>
            </td>
          </tr>` : `<tr><td style="height:10px;line-height:10px;">&nbsp;</td></tr>`}

          <!-- Footer -->
          <tr>
            <td style="background:${c.page};padding:20px 28px;border-top:1px solid ${c.border};
                       font-family:Arial,Helvetica,sans-serif;color:${c.muted};font-size:12px;
                       line-height:1.6;">
              ${footerNote ? `<div style="margin-bottom:10px;">${footerNote}</div>` : ''}
              <div>
                Need help? Email
                <a href="mailto:${BRAND.supportEmail}" style="color:${c.primaryDk};">${BRAND.supportEmail}</a>
                ${BRAND.supportPhone ? ` · Call ${esc(BRAND.supportPhone)}` : ''}
              </div>
              <div style="margin-top:8px;">
                Book a paediatric consultation:
                <a href="${BRAND.primaryUrl}" style="color:${c.primaryDk};">neokidspro.in</a>
                &nbsp;·&nbsp; Vaccination portal:
                <a href="${BRAND.vaxUrl}" style="color:${c.primaryDk};">vaxiclinics.com</a>
              </div>
              <div style="margin-top:12px;color:#9CA3AF;">
                © ${new Date().getUTCFullYear()} ${esc(BRAND.name)}. This is an automated message —
                please do not reply directly. Reply STOP to opt out of non-transactional
                reminders.
              </div>
            </td>
          </tr>

        </table>

      </td></tr>
    </table>
  </body>
</html>`;
}

module.exports = { renderBrandedEmail, BRAND, esc };
