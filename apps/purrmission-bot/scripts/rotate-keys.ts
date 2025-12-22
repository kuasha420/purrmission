import { z } from 'zod';
import { getPrismaClient } from '../src/infra/prismaClient.js';
import { decryptValue, encryptValue } from '../src/infra/crypto.js';
import { backupDatabase } from './backup-db.js';
import { logger } from '../src/logging/logger.js';
import { env } from '../src/config/env.js';

const HEX_REGEX = /^[0-9a-fA-F]{64}$/;

interface RotateConfig {
    dryRun: boolean;
    batchSize: number;
    oldKey: Buffer;
    newKey: Buffer;
}

// Minimal args parser
function parseArgs(): RotateConfig {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');

    // Parse batch size
    const batchIndex = args.indexOf('--batch-size');
    const batchSize = batchIndex !== -1 ? parseInt(args[batchIndex + 1], 10) : 100;

    // Determine keys
    // Priority: Command line args > Env vars > Current Env (for old key only)

    // Old Key
    let oldKeyHex = process.env.ENCRYPTION_KEY_OLD;
    const fromKeyIndex = args.indexOf('--from-key');
    if (fromKeyIndex !== -1) oldKeyHex = args[fromKeyIndex + 1];

    // If no old key specified, assume simple re-encryption with CURRENT key 
    // (e.g. migrating legacy format to v1 format using same key)
    if (!oldKeyHex && env.ENCRYPTION_KEY) {
        logger.info('ℹ️ No old key specified, using current ENCRYPTION_KEY as old key.');
        oldKeyHex = env.ENCRYPTION_KEY;
    }

    // New Key
    let newKeyHex = process.env.ENCRYPTION_KEY_NEW;
    const toKeyIndex = args.indexOf('--to-key');
    if (toKeyIndex !== -1) newKeyHex = args[toKeyIndex + 1];

    if (!newKeyHex) {
        // If we are just migrating formats, new key could be same as old key
        // BUT for rotation we usually want explicit new key.
        // If user wants to re-encrypt with SAME key (format migration), they should pass it.
        // We will fallback to current env key if not specified, assuming this is a format upgrade.
        logger.info('ℹ️ No new key specified, using current ENCRYPTION_KEY as new key.');
        newKeyHex = env.ENCRYPTION_KEY;
    }

    if (!oldKeyHex || !HEX_REGEX.test(oldKeyHex)) {
        throw new Error('Old Key must be a valid 32-byte hex string. Provide via --from-key or ENCRYPTION_KEY_OLD.');
    }
    if (!newKeyHex || !HEX_REGEX.test(newKeyHex)) {
        throw new Error('New Key must be a valid 32-byte hex string. Provide via --to-key or ENCRYPTION_KEY_NEW.');
    }

    return {
        dryRun,
        batchSize,
        oldKey: Buffer.from(oldKeyHex, 'hex'),
        newKey: Buffer.from(newKeyHex, 'hex'),
    };
}

async function main() {
    try {
        const config = parseArgs();

        logger.info('🔐 Starting Key Rotation / Re-encryption');
        logger.info(`Dry Run: ${config.dryRun}`);
        logger.info(`Batch Size: ${config.batchSize}`);

        if (config.oldKey.equals(config.newKey)) {
            logger.info('ℹ️ Old Key matches New Key. This operation will update ciphertext formats to v1.');
        } else {
            logger.info('⚠️ ROTATING KEYS: Old and New keys are different.');
        }

        if (!config.dryRun) {
            await backupDatabase();
        }

        const prisma = getPrismaClient();

        // 1. Rotate TOTP Accounts
        logger.info('🔄 Processing TOTP Accounts...');
        const totpCount = await prisma.tOTPAccount.count();
        let processedTotp = 0;
        let diffsTotp = 0;
        let verifiedTotp = 0;

        for (let i = 0; i < totpCount; i += config.batchSize) {
            const batch = await prisma.tOTPAccount.findMany({
                take: config.batchSize,
                skip: i,
            });

            for (const account of batch) {
                try {
                    let plaintext: string;
                    try {
                        plaintext = decryptValue(account.secret, config.oldKey);
                    } catch (err) {
                        // Fallback: If not v1/legacy ciphertext, assume plaintext (bug fix)
                        if (!account.secret.startsWith('v1:') && !account.secret.includes(':')) {
                            logger.warn(`⚠️  Found unencrypted secret for account ${account.id} (${account.accountName}). Encrypting it now.`);
                            plaintext = account.secret;
                        } else {
                            throw err;
                        }
                    }

                    // Always re-encrypt to ensure v1 format and/or new key
                    const newCiphertext = encryptValue(plaintext, config.newKey);

                    if (newCiphertext !== account.secret) {
                        diffsTotp++;
                        if (!config.dryRun) {
                            await prisma.tOTPAccount.update({
                                where: { id: account.id },
                                data: { secret: newCiphertext },
                            });
                            // Verify immediately
                            const check = await prisma.tOTPAccount.findUnique({ where: { id: account.id } });
                            if (check && decryptValue(check.secret, config.newKey) === plaintext) {
                                verifiedTotp++;
                            } else {
                                logger.error(`❌ Verification failed for TOTP Account ${account.id}`);
                            }
                        }
                    }
                } catch (err) {
                    logger.error(`❌ Failed to process TOTP Account ${account.id}: ${err}`);
                }
                processedTotp++;
            }
        }
        logger.info(`✅ TOTP Accounts: Scanned ${processedTotp}, Needed Update ${diffsTotp}, Verified ${verifiedTotp}`);


        // 2. Rotate Resource Fields
        logger.info('🔄 Processing Resource Fields...');
        const fieldCount = await prisma.resourceField.count();
        let processedFields = 0;
        let diffsFields = 0;
        let verifiedFields = 0;

        for (let i = 0; i < fieldCount; i += config.batchSize) {
            const batch = await prisma.resourceField.findMany({
                take: config.batchSize,
                skip: i,
            });

            for (const field of batch) {
                try {
                    let plaintext: string;
                    try {
                        plaintext = decryptValue(field.value, config.oldKey);
                    } catch (err) {
                        // Fallback: If not v1/legacy ciphertext, assume plaintext (bug fix)
                        if (!field.value.startsWith('v1:') && !field.value.includes(':')) {
                            logger.warn(`⚠️  Found unencrypted value for field ${field.id} (${field.name}). Encrypting it now.`);
                            plaintext = field.value;
                        } else {
                            throw err;
                        }
                    }

                    const newCiphertext = encryptValue(plaintext, config.newKey);

                    if (newCiphertext !== field.value) {
                        diffsFields++;
                        if (!config.dryRun) {
                            await prisma.resourceField.update({
                                where: { id: field.id },
                                data: { value: newCiphertext },
                            });
                            // Verify
                            const check = await prisma.resourceField.findUnique({ where: { id: field.id } });
                            if (check && decryptValue(check.value, config.newKey) === plaintext) {
                                verifiedFields++;
                            } else {
                                logger.error(`❌ Verification failed for Resource Field ${field.id}`);
                            }
                        }
                    }
                } catch (err) {
                    logger.error(`❌ Failed to process Resource Field ${field.id}: ${err}`);
                }
                processedFields++;
            }
        }
        logger.info(`✅ Resource Fields: Scanned ${processedFields}, Needed Update ${diffsFields}, Verified ${verifiedFields}`);

        logger.info('✨ Rotation complete.');
    } catch (error) {
        logger.error('Fatal Rotation Error:', error);
        process.exit(1);
    }
}

main();
