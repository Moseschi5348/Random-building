import { describe, expect, it } from "vitest";
import {
  createOtp,
  hashOtp,
  isSchoolEmail,
  verifyOtp,
} from "../src/otp";

describe("NUTM email verification codes", () => {
  it("generates six-digit codes and verifies only the matching school email", () => {
    const email = "eevans@nutm.edu.ng";
    const code = createOtp();
    const secret = "test-only-otp-secret-with-more-than-32-characters";
    const storedHash = hashOtp(email, code, secret);

    expect(code).toMatch(/^\d{6}$/);
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedHash).not.toBe(code);
    expect(verifyOtp(email, code, storedHash, secret)).toBe(true);
    expect(verifyOtp("other@nutm.edu.ng", code, storedHash, secret)).toBe(false);
    const wrongCode = code === "000000" ? "000001" : "000000";
    expect(verifyOtp(email, wrongCode, storedHash, secret)).toBe(false);
  });

  it("accepts only addresses in the NUTM email domain", () => {
    expect(isSchoolEmail("eevans@nutm.edu.ng")).toBe(true);
    expect(isSchoolEmail("EEVANS@NUTM.EDU.NG")).toBe(true);
    expect(isSchoolEmail("eevans@example.com")).toBe(false);
    expect(isSchoolEmail("eevans@notnutm.edu.ng")).toBe(false);
  });
});
