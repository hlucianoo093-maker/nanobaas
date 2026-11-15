import nodemailer from "nodemailer";
import type { AppConfig } from "./config.js";

export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

export function createEmailSender(config: AppConfig): EmailSender | undefined {
  if (!config.SMTP_HOST || !config.SMTP_FROM) return undefined;

  const port = config.SMTP_PORT ?? 587;
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port,
    secure: port === 465,
    ...(config.SMTP_USER && config.SMTP_PASSWORD
      ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
      : {})
  });

  return {
    async send(to, subject, text) {
      await transport.sendMail({ from: config.SMTP_FROM, to, subject, text });
    }
  };
}
