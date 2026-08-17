// =====================================================================
// historical-record.service.js — v3.4.3
// Secure share tokens + signed file URLs + PDF hook + WA/Email delivery
// =====================================================================
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const SECRET = process.env.FILE_TOKEN_SECRET || process.env.JWT_SECRET || 'neokidspro-file-secret';
const SHARE_TTL_SEC = parseInt(process.env.HISTORICAL_SHARE_TTL_SEC || '604800', 10); // 7 days
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');

function b64url(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function sign(payload){
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return body + '.' + sig;
}
function verify(token){
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const body = token.slice(0, i), sig = token.slice(i+1);
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try { const p = JSON.parse(Buffer.from(body.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8')); if (p.exp && p.exp < Math.floor(Date.now()/1000)) return null; return p; } catch { return null; }
}

function attachmentToken(att){ return sign({ t:'att', id: att.id, p: att.storagePath, n: att.originalName, m: att.mimeType, exp: Math.floor(Date.now()/1000)+SHARE_TTL_SEC }); }
function recordShareToken(record){ return sign({ t:'rec', id: record.id, exp: Math.floor(Date.now()/1000)+SHARE_TTL_SEC }); }

function publicBase(req){
  return process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));
}
function attachmentUrls(req, att){
  const tok = attachmentToken(att);
  const base = publicBase(req);
  return { view: base + '/api/files/share/' + tok + '?dl=0', download: base + '/api/files/share/' + tok + '?dl=1' };
}
function recordShareUrl(req, record){
  return publicBase(req) + '/api/files/share-record/' + recordShareToken(record);
}

function decorateRecord(req, record){
  const atts = (record.attachments || []).map(a => {
    const u = attachmentUrls(req, a);
    return { id: a.id, label: a.label || a.originalName, originalName: a.originalName, mimeType: a.mimeType, sizeBytes: a.sizeBytes, kind: a.kind, attachmentType: a.attachmentType || null, notes: a.notes || null, sortOrder: a.sortOrder || 0, createdAt: a.createdAt, viewUrl: u.view, downloadUrl: u.download };
  });
  return Object.assign({}, record, { attachments: atts, shareUrl: recordShareUrl(req, record) });
}

async function deliver({ channel, to, patientName, doctorName, recordType, recordDate, url, clinicName, attachmentPath, attachmentName }){
  const results = { channel };
  if (channel === 'email') {
    const { sendEmail } = require('./email.service');
    const mail = {
      to,
      subject: `Medical Record Shared — ${patientName} (${recordDate})`,
      html: `<h2>Medical Record Shared</h2>
<p>Hello ${patientName},</p>
<p>${doctorName} has shared a medical record for your reference.</p>
<p><b>Record Type:</b> ${recordType}<br/><b>Record Date:</b> ${recordDate}</p>
<p><a href="${url}">View Record</a> (secure link, expires in 7 days)</p>
<p>For assistance, contact: ${clinicName}</p><p>Regards,<br/>NeoKidsPro</p>`
    };
    if (attachmentPath && fs.existsSync(attachmentPath)) mail.attachments = [{ filename: attachmentName, path: attachmentPath }];
    results.email = await sendEmail(mail);
  } else if (channel === 'whatsapp') {
    try {
      const wa = require('./whatsapp.service');
      const fn = wa.sendTemplate || wa.sendWhatsAppTemplate || wa.sendText || wa.sendViaMetaText;
      const body = `Hello ${patientName},\n\n${doctorName} has shared a medical record for your reference.\n\nRecord Type: ${recordType}\nRecord Date: ${recordDate}\n\nAccess it securely: ${url}\n\nFor assistance, contact: ${clinicName}\nRegards, NeoKidsPro`;
      if (fn) results.whatsapp = await fn({ to, template: 'historical_record_shared', params: [patientName, doctorName, recordType, recordDate, url, clinicName], body });
      else results.whatsapp = { skipped: true, reason: 'whatsapp sender not available', fallbackLink: url };
    } catch (e) { results.whatsapp = { error: e.message, fallbackLink: url }; }
  }
  return results;
}

module.exports = { sign, verify, attachmentToken, recordShareToken, attachmentUrls, recordShareUrl, decorateRecord, deliver, SHARE_TTL_SEC, STORAGE_PATH };
