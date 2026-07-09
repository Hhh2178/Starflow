import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

const PREFIX = "scrypt";
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${PREFIX}:${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash?: string | null): boolean {
  if (!storedHash) return false;

  const [prefix, salt, expectedHash] = storedHash.split(":");
  if (prefix !== PREFIX || !salt || !expectedHash) return false;

  const actual = Buffer.from(scryptSync(password, salt, KEY_LENGTH).toString("hex"), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}
