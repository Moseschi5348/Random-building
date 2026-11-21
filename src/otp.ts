import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const SCHOOL_EMAIL_DOMAIN = "@nutm.edu.ng";
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export function isSchoolEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(SCHOOL_EMAIL_DOMAIN);
}

export function createOtp(): string {
  return randomInt(100_000, 1_000_000).toString();
}

export function hashOtp(email: string, code: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${email.toLowerCase()}:${code}`)
    .digest("hex");
}

export function verifyOtp(
  email: string,
  code: string,
  expectedHash: string,
  secret: string,
): boolean {
  if (!/^\d{6}$/.test(code) || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    return false;
  }
  const actualHash = Buffer.from(hashOtp(email, code, secret), "hex");
  const storedHash = Buffer.from(expectedHash, "hex");
  return actualHash.length === storedHash.length && timingSafeEqual(actualHash, storedHash);
}
