import { createPublicKey, type KeyObject, verify } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

export function verifySignature(body: unknown, signature: string, publicKey: KeyObject): boolean {
  return verify(
    null,
    Buffer.from(canonicalJson(body)),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
}

export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}
