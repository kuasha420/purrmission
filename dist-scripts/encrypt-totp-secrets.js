#!/usr/bin/env tsx
import {
  decryptValue,
  encryptValue
} from "./chunk-NS5LOM5Y.js";
import "./chunk-CHKU34YE.js";

// scripts/encrypt-totp-secrets.ts
import { PrismaClient } from "@prisma/client";
import * as dotenv from "dotenv";
dotenv.config();
var APPLY_CHANGES = process.argv.includes("--apply");
function isEncrypted(value) {
  try {
    decryptValue(value);
    return true;
  } catch {
    return false;
  }
}
function looksLikePlaintextSecret(value) {
  const base32Regex = /^[A-Z2-7]+=*$/i;
  if (value.length < 10 || value.length > 100) {
    return false;
  }
  return base32Regex.test(value);
}
function encryptAndValidate(secret, backupKey, secretIsEncrypted, backupIsEncrypted) {
  const encryptedSecret = secretIsEncrypted ? secret : encryptValue(secret);
  const encryptedBackupKey = backupKey ? backupIsEncrypted ? backupKey : encryptValue(backupKey) : null;
  decryptValue(encryptedSecret);
  if (backupKey && encryptedBackupKey) {
    decryptValue(encryptedBackupKey);
  }
  return { encryptedSecret, encryptedBackupKey };
}
async function main() {
  console.log("\u{1F510} TOTP Secret Encryption Migration Script\n");
  if (!process.env.ENCRYPTION_KEY) {
    console.error("\u274C Error: ENCRYPTION_KEY environment variable is not set");
    console.error("   Please set ENCRYPTION_KEY before running this script");
    process.exit(1);
  }
  console.log(`Mode: ${APPLY_CHANGES ? "\u270D\uFE0F  APPLY (will modify database)" : "\u{1F441}\uFE0F  DRY RUN (read-only)"}
`);
  const prisma = new PrismaClient();
  try {
    const accounts = await prisma.tOTPAccount.findMany();
    console.log(`Found ${accounts.length} TOTP account(s) in database
`);
    if (accounts.length === 0) {
      console.log("\u2705 No accounts to process");
      return;
    }
    let encryptedCount = 0;
    let plaintextCount = 0;
    let skippedCount = 0;
    const accountsToUpdate = [];
    for (const account of accounts) {
      const accountLabel = `${account.accountName} (${account.id})`;
      const secretIsEncrypted = isEncrypted(account.secret);
      const secretIsPlaintext = !secretIsEncrypted && looksLikePlaintextSecret(account.secret);
      let backupIsEncrypted = false;
      let backupIsPlaintext = false;
      if (account.backupKey) {
        backupIsEncrypted = isEncrypted(account.backupKey);
        backupIsPlaintext = !backupIsEncrypted && looksLikePlaintextSecret(account.backupKey);
      }
      if (secretIsEncrypted && (!account.backupKey || backupIsEncrypted)) {
        console.log(`\u2705 ${accountLabel}: Already encrypted`);
        encryptedCount++;
      } else if (secretIsPlaintext || backupIsPlaintext) {
        console.log(`\u{1F513} ${accountLabel}: Found plaintext data`);
        plaintextCount++;
        try {
          const { encryptedSecret, encryptedBackupKey } = encryptAndValidate(
            account.secret,
            account.backupKey,
            secretIsEncrypted,
            backupIsEncrypted
          );
          console.log(`   \u2713 Validated encryption/decryption`);
          accountsToUpdate.push({
            id: account.id,
            accountName: account.accountName,
            encryptedSecret,
            encryptedBackupKey
          });
        } catch (error) {
          console.error(`   \u2717 Encryption validation failed for ${accountLabel}:`, error);
          skippedCount++;
        }
      } else {
        console.log(`\u26A0\uFE0F  ${accountLabel}: Unknown format (not plaintext, not encrypted)`);
        skippedCount++;
      }
    }
    console.log(`
\u{1F4CA} Summary:`);
    console.log(`   Already encrypted: ${encryptedCount}`);
    console.log(`   Plaintext found:   ${plaintextCount}`);
    console.log(`   Skipped:           ${skippedCount}`);
    console.log(`   To update:         ${accountsToUpdate.length}`);
    if (accountsToUpdate.length === 0) {
      console.log("\n\u2705 Nothing to update");
      return;
    }
    if (!APPLY_CHANGES) {
      console.log("\n\u{1F6A8} WARNING: This operation can be destructive. Please back up your database before proceeding.");
      console.log("\u{1F4A1} This was a dry run. Use --apply flag to actually update the database:");
      console.log("   ENCRYPTION_KEY=<your-key> tsx scripts/encrypt-totp-secrets.ts --apply");
      return;
    }
    console.log("\n\u{1F504} Applying changes to database (atomic transaction)...");
    await prisma.$transaction(
      accountsToUpdate.map(
        (update) => prisma.tOTPAccount.update({
          where: { id: update.id },
          data: {
            secret: update.encryptedSecret,
            backupKey: update.encryptedBackupKey
          }
        })
      )
    );
    accountsToUpdate.forEach((update) => {
      console.log(`   \u2713 Updated: ${update.accountName}`);
    });
    console.log(`
\u2705 Successfully encrypted ${accountsToUpdate.length} TOTP account(s)`);
  } catch (error) {
    console.error("\n\u274C Error during migration:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
main();
