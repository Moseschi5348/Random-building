import { ConfidentialClientApplication } from "@azure/msal-node";
import type { AppConfig } from "./config";

export class GraphOtpMailer {
  private readonly client: ConfidentialClientApplication;

  constructor(
    private readonly config: NonNullable<AppConfig["graph"]>,
  ) {
    this.client = new ConfidentialClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        clientSecret: config.clientSecret,
      },
    });
  }

  async sendVerificationCode(recipient: string, code: string): Promise<void> {
    const token = await this.client.acquireTokenByClientCredential({
      scopes: ["https://graph.microsoft.com/.default"],
    });
    if (!token?.accessToken) {
      throw new Error("Microsoft Graph did not return an application access token.");
    }

    const response = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.config.senderEmail)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          message: {
            subject: "Your NUTM account verification code",
            body: {
              contentType: "Text",
              content: `Your NUTM Student Life verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
            },
            toRecipients: [{ emailAddress: { address: recipient } }],
          },
          saveToSentItems: false,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Microsoft Graph sendMail failed with status ${response.status}.`);
    }
  }
}
