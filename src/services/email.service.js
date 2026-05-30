/**
 * Email Notifications via SMTP / SendGrid
 */
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return transporter;
}

async function sendEmail({ to, subject, html, text, attachments }) {
  if (!to) return { skipped: true };
  const t = getTransporter();
  if (!t) {
    logger.info(`[EMAIL-MOCK] To ${to}: ${subject}`);
    return { messageId: 'mock_' + Date.now() };
  }
  const info = await t.sendMail({
    from: process.env.SMTP_FROM || 'noreply@neokidspro.in',
    to, subject, html, text, attachments
  });
  return { messageId: info.messageId };
}

module.exports = { sendEmail };
