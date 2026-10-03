// Outgoing email. The transport is selected by the "mail" section of the
// configuration; without it, messages are written to the log so that a
// development setup works without a mail server.

import { createTransport } from 'nodemailer';
import type { Config } from '../config.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export class LogMailer implements Mailer {
  async send(msg: MailMessage): Promise<void> {
    console.log(`[mail] To: ${msg.to}\n[mail] Subject: ${msg.subject}\n${msg.text}`);
  }
}

// Keeps sent messages in memory; used by tests.
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

class NodemailerMailer implements Mailer {
  private from: string;
  private transport: ReturnType<typeof createTransport>;

  constructor(from: string, transport: ReturnType<typeof createTransport>) {
    this.from = from;
    this.transport = transport;
  }

  async send(msg: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text });
  }
}

export function createMailer(config: Config): Mailer {
  const m = config.mail;
  switch (m.transport) {
    case 'smtp': {
      const s = m.smtp;
      if (!s?.host) throw new Error('mail.smtp.host is required for the smtp transport');
      return new NodemailerMailer(m.from, createTransport({
        host: s.host,
        port: s.port ?? (s.secure ? 465 : 587),
        secure: s.secure ?? false,
        auth: s.user ? { user: s.user, pass: s.password ?? '' } : undefined,
      }));
    }
    case 'sendmail':
      return new NodemailerMailer(m.from, createTransport({ sendmail: true, path: m.sendmailPath ?? '/usr/sbin/sendmail' }));
    default:
      return new LogMailer();
  }
}
