// Optional email (reminders). Without SMTP_HOST nothing is sent and Apprua works the same.
import nodemailer from 'nodemailer';
import { config } from './config.js';

const smtp = {
  host: process.env.SMTP_HOST ?? '',
  port: Number(process.env.SMTP_PORT ?? 587),
  user: process.env.SMTP_USER ?? process.env.SMTP_FROM ?? '',
  from: process.env.SMTP_FROM ?? '',
  password: process.env.SMTP_PASSWORD ?? '',
  admin: process.env.ADMIN_EMAIL ?? '',
};

export const mailEnabled = () => !!(smtp.host && smtp.from);

export async function sendMail(to: string[], subject: string, text: string, opts: { copyAdmin?: boolean } = {}): Promise<void> {
  if (!mailEnabled()) { console.warn(`[notify] email not configured, not sent: ${subject}`); return; }
  const transport = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.port === 465, requireTLS: smtp.port !== 465 && smtp.port !== 25,
    auth: smtp.password ? { user: smtp.user, pass: smtp.password } : undefined,
  });
  const recipients = [...new Set(to.filter((t) => t.toLowerCase() !== smtp.admin.toLowerCase()))];
  await transport.sendMail({
    from: `${config.brand} <${smtp.from}>`,
    to: recipients.length ? recipients.join(', ') : smtp.admin,
    cc: recipients.length && smtp.admin && opts.copyAdmin !== false ? smtp.admin : undefined,
    subject: `[${config.brand}] ${subject}`,
    text,
  });
}
