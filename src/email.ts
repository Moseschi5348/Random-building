import nodemailer, { type Transporter } from "nodemailer";
import type { AppConfig } from "./config";

export class GmailOtpMailer {
  private readonly transporter: Transporter;

  constructor(private readonly config: NonNullable<AppConfig["gmail"]>) {
    this.transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: config.user,
        pass: config.appPassword,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  }

  async sendVerificationCode(recipient: string, code: string): Promise<void> {
    await this.transporter.sendMail({
      from: { name: "DIS Student Life", address: this.config.user },
      to: recipient,
      subject: "Your NUTM account verification code",
      text: `Your DIS Student Life verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    });
  }
}
