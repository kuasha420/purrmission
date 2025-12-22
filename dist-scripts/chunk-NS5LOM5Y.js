import {
  env
} from "./chunk-CHKU34YE.js";

// apps/purrmission-bot/src/infra/crypto.ts
import crypto from "crypto";
var ALGORITHM = "aes-256-gcm";
var IV_LENGTH = 12;
var AUTH_TAG_LENGTH = 16;
var HEX_REGEX = /^[0-9a-fA-F]{64}$/;
var V1_PREFIX = "v1:";
function getEncryptionKey() {
  const keyHex = env.ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  if (!HEX_REGEX.test(keyHex)) {
    throw new Error("ENCRYPTION_KEY must be a valid 32-byte hex string (64 hexadecimal characters)");
  }
  return Buffer.from(keyHex, "hex");
}
function encryptValue(plaintext, keyBuffer) {
  const key = keyBuffer || getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${V1_PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}
function decryptValue(ciphertext, keyBuffer) {
  const key = keyBuffer || getEncryptionKey();
  let ivStr, tagStr, dataStr;
  if (ciphertext.startsWith(V1_PREFIX)) {
    const parts = ciphertext.slice(V1_PREFIX.length).split(":");
    if (parts.length !== 3) {
      throw new Error("Decryption failed: invalid v1 data format");
    }
    [ivStr, tagStr, dataStr] = parts;
  } else {
    const parts = ciphertext.split(":");
    if (parts.length !== 3) {
      throw new Error("Decryption failed: invalid legacy data format");
    }
    [ivStr, tagStr, dataStr] = parts;
  }
  try {
    const iv = Buffer.from(ivStr, "base64");
    const authTag = Buffer.from(tagStr, "base64");
    const encrypted = Buffer.from(dataStr, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH
    });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    throw new Error("Decryption failed: invalid data or wrong key");
  }
}

export {
  encryptValue,
  decryptValue
};
