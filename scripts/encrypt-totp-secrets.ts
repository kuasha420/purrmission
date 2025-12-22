#!/usr/bin/env tsx
/**
 * Migration script to encrypt existing plaintext TOTP secrets.
 * 
 * This script should be run once after deploying the TOTP encryption feature.
 * It will:
 * 1. Read all TOTP accounts from the database
 * 2. Check if secrets are already encrypted (by attempting to decrypt)
 * 3. Encrypt any plaintext secrets found
 * 4. Update the database with encrypted values
 * 
 * Usage:
 *   ENCRYPTION_KEY=<your-key> tsx scripts/encrypt-totp-secrets.ts
 * 
 * Safety:
 * - Dry run by default (use --apply to actually update the database)
 * - IMPORTANT: Back up your database manually before using the --apply flag.
 * - Validates encryption/decryption before committing changes
 */

import { PrismaClient } from '@prisma/client';
import { encryptValue, decryptValue } from '../apps/purrmission-bot/src/infra/crypto.js';
import * as dotenv from 'dotenv';

dotenv.config();

const APPLY_CHANGES = process.argv.includes('--apply');

/**
 * Check if a value is already encrypted by attempting to decrypt it.
 */
function isEncrypted(value: string): boolean {
  try {
    decryptValue(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a value looks like a valid Base32 TOTP secret (plaintext).
 * 
 * This is a heuristic check with limitations:
 * - Base32 alphabet consists of A-Z, 2-7, and optional padding (=)
 * - Typical TOTP secrets are 16-32 characters (80-160 bits)
 * - May produce false negatives for very short or long secrets
 * - May produce false positives for encrypted data that happens to contain only Base32 chars
 * 
 * Used in conjunction with isEncrypted() to determine migration needs.
 */
function looksLikePlaintextSecret(value: string): boolean {
  // Base32 alphabet: A-Z (uppercase), 2-7, and optional padding =
  // Note: Base32 is case-insensitive but typically uppercase by convention
  const base32Regex = /^[A-Z2-7]+=*$/;

  // Typical TOTP secrets are 16-32 characters (without padding)
  // Too short or too long is suspicious
  if (value.length < 10 || value.length > 100) {
    return false;
  }

  return base32Regex.test(value);
}

/**
 * Encrypt secret and optional backup key, with validation.
 * Returns encrypted values or throws on validation failure.
 */
function encryptAndValidate(
  secret: string,
  backupKey: string | null,
  secretIsEncrypted: boolean,
  backupIsEncrypted: boolean
): { encryptedSecret: string; encryptedBackupKey: string | null } {
  const encryptedSecret = secretIsEncrypted ? secret : encryptValue(secret);
  const encryptedBackupKey = backupKey
    ? (backupIsEncrypted ? backupKey : encryptValue(backupKey))
    : null;

  // Validate by decrypting
  decryptValue(encryptedSecret);
  if (backupKey && encryptedBackupKey) {
    decryptValue(encryptedBackupKey);
  }

  return { encryptedSecret, encryptedBackupKey };
}

async function main() {
  console.log('🔐 TOTP Secret Encryption Migration Script\n');

  if (!process.env.ENCRYPTION_KEY) {
    console.error('❌ Error: ENCRYPTION_KEY environment variable is not set');
    console.error('   Please set ENCRYPTION_KEY before running this script');
    process.exit(1);
  }

  console.log(`Mode: ${APPLY_CHANGES ? '✍️  APPLY (will modify database)' : '👁️  DRY RUN (read-only)'}\n`);

  const prisma = new PrismaClient();

  try {
    // Fetch all TOTP accounts
    const accounts = await prisma.tOTPAccount.findMany();

    console.log(`Found ${accounts.length} TOTP account(s) in database\n`);

    if (accounts.length === 0) {
      console.log('✅ No accounts to process');
      return;
    }

    let encryptedCount = 0;
    let plaintextCount = 0;
    let skippedCount = 0;

    const accountsToUpdate: Array<{
      id: string;
      accountName: string;
      encryptedSecret: string;
      encryptedBackupKey: string | null;
    }> = [];

    // Analyze each account
    for (const account of accounts) {
      const accountLabel = `${account.accountName} (${account.id})`;

      // Check secret
      const secretIsEncrypted = isEncrypted(account.secret);
      const secretIsPlaintext = !secretIsEncrypted && looksLikePlaintextSecret(account.secret);

      // Check backup key if present
      let backupIsEncrypted = false;
      let backupIsPlaintext = false;
      if (account.backupKey) {
        backupIsEncrypted = isEncrypted(account.backupKey);
        backupIsPlaintext = !backupIsEncrypted && looksLikePlaintextSecret(account.backupKey);
      }

      if (secretIsEncrypted && (!account.backupKey || backupIsEncrypted)) {
        console.log(`✅ ${accountLabel}: Already encrypted`);
        encryptedCount++;
      } else if (secretIsPlaintext || backupIsPlaintext) {
        console.log(`🔓 ${accountLabel}: Found plaintext data`);
        plaintextCount++;

        // Encrypt the secret and backup key with validation
        try {
          const { encryptedSecret, encryptedBackupKey } = encryptAndValidate(
            account.secret,
            account.backupKey,
            secretIsEncrypted,
            backupIsEncrypted
          );

          console.log(`   ✓ Validated encryption/decryption`);

          accountsToUpdate.push({
            id: account.id,
            accountName: account.accountName,
            encryptedSecret,
            encryptedBackupKey,
          });
        } catch (error) {
          console.error(`   ✗ Encryption validation failed for ${accountLabel}:`, error);
          skippedCount++;
        }
      } else {
        console.log(`⚠️  ${accountLabel}: Unknown format (not plaintext, not encrypted)`);
        skippedCount++;
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Already encrypted: ${encryptedCount}`);
    console.log(`   Plaintext found:   ${plaintextCount}`);
    console.log(`   Skipped:           ${skippedCount}`);
    console.log(`   To update:         ${accountsToUpdate.length}`);

    if (accountsToUpdate.length === 0) {
      console.log('\n✅ Nothing to update');
      return;
    }

    if (!APPLY_CHANGES) {
      console.log('\n🚨 WARNING: This operation can be destructive. Please back up your database before proceeding.');
      console.log('💡 This was a dry run. Use --apply flag to actually update the database:');
      console.log('   ENCRYPTION_KEY=<your-key> tsx scripts/encrypt-totp-secrets.ts --apply');
      return;
    }

    // Apply changes atomically using a transaction
    console.log('\n🔄 Applying changes to database (atomic transaction)...');

    await prisma.$transaction(
      accountsToUpdate.map((update) =>
        prisma.tOTPAccount.update({
          where: { id: update.id },
          data: {
            secret: update.encryptedSecret,
            backupKey: update.encryptedBackupKey,
          },
        })
      )
    );

    accountsToUpdate.forEach((update) => {
      console.log(`   ✓ Updated: ${update.accountName}`);
    });

    console.log(`\n✅ Successfully encrypted ${accountsToUpdate.length} TOTP account(s)`);

  } catch (error) {
    console.error('\n❌ Error during migration:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
