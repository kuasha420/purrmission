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
    let batchSize = 100;
    if (batchIndex !== -1) {
        const val = args[batchIndex + 1];
        if (!val || val.startsWith('--')) {
            throw new Error('Missing or invalid value for --batch-size');
        }
        batchSize = parseInt(val, 10);
        if (isNaN(batchSize) || batchSize <= 0) {
            throw new Error('Invalid value for --batch-size. Must be a positive number.');
        }
    }

    // Determine keys
    // Priority: Command line args > Env vars > Current Env (for old key only)

    // Old Key
    let oldKeyHex = process.env.ENCRYPTION_KEY_OLD;
    const fromKeyIndex = args.indexOf('--from-key');
    if (fromKeyIndex !== -1) {
        const val = args[fromKeyIndex + 1];
        if (!val || val.startsWith('--')) {
            throw new Error('Missing or invalid value for --from-key');
        }
        oldKeyHex = val;
    }

    // If no old key specified, assume simple re-encryption with CURRENT key 
    if (!oldKeyHex && env.ENCRYPTION_KEY) {
        logger.info('ℹ️ No old key specified, using current ENCRYPTION_KEY as old key.');
        oldKeyHex = env.ENCRYPTION_KEY;
    }

    // New Key
    let newKeyHex = process.env.ENCRYPTION_KEY_NEW;
    const toKeyIndex = args.indexOf('--to-key');
    if (toKeyIndex !== -1) {
        const val = args[toKeyIndex + 1];
        if (!val || val.startsWith('--')) {
            throw new Error('Missing or invalid value for --to-key');
        }
        newKeyHex = val;
    }

    if (!newKeyHex) {
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

/**
 * Generic function to rotate encrypted fields on a Prisma model.
 */
async function rotateEncryptedModel(
    modelDelegate: any,
    modelName: string,
    encryptedFieldName: string,
    displayFieldName: string,
    config: RotateConfig
): Promise<number> {
    logger.info(`🔄 Processing ${modelName}...`);
    const total = await modelDelegate.count();
    let processed = 0;
    let updated = 0;
    let verified = 0;
    let failed = 0;

    for (let i = 0; i < total; i += config.batchSize) {
        const batch = await modelDelegate.findMany({
            take: config.batchSize,
            skip: i,
        });

        for (const item of batch) {
            try {
                const ciphertext = item[encryptedFieldName];
                if (!ciphertext) {
                    processed++;
                    continue;
                }

                let plaintext: string;
                try {
                    plaintext = decryptValue(ciphertext, config.oldKey);
                } catch (err) {
                    // Refined plaintext detection:
                    // 1. Doesn't look like v1 format (v1:iv:tag:data)
                    // 2. Or is explicitly an otpauth URI (which has colons but is plaintext)
                    const looksLikeV1 = ciphertext.startsWith('v1:') && ciphertext.split(':').length === 4;
                    const isExplicitPlaintext = ciphertext.startsWith('otpauth://');

                    if (!looksLikeV1 || isExplicitPlaintext) {
                        logger.warn(`⚠️  Found likely unencrypted data for ${modelName} ${item.id} (${item[displayFieldName]}). Encrypting now.`);
                        plaintext = ciphertext;
                    } else {
                        throw err;
                    }
                }

                // Always re-encrypt to ensure latest format (v1) and target key
                const newCiphertext = encryptValue(plaintext, config.newKey);

                if (newCiphertext !== ciphertext) {
                    updated++;
                    if (!config.dryRun) {
                        await modelDelegate.update({
                            where: { id: item.id },
                            data: { [encryptedFieldName]: newCiphertext },
                        });

                        // Verification
                        const check = await modelDelegate.findUnique({ where: { id: item.id } });
                        if (check && decryptValue(check[encryptedFieldName], config.newKey) === plaintext) {
                            verified++;
                        } else {
                            logger.error(`❌ Verification failed for ${modelName} ${item.id}`);
                            failed++;
                        }
                    }
                } else {
                    // Already in sync
                    verified++;
                }
            } catch (err) {
                logger.error(`❌ Failed to process ${modelName} ${item.id}: ${err}`);
                failed++;
            }
            processed++;
        }
    }

    logger.info(`✅ ${modelName}: Scanned ${processed}, Updated ${updated}, Verified ${verified}, Failed ${failed}`);
    return failed;
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

        let totalFailures = 0;

        // 1. Rotate TOTP Accounts
        totalFailures += await rotateEncryptedModel(
            prisma.tOTPAccount,
            'TOTPAccount',
            'secret',
            'accountName',
            config
        );

        // 2. Rotate Resource Fields
        totalFailures += await rotateEncryptedModel(
            prisma.resourceField,
            'ResourceField',
            'value',
            'name',
            config
        );

        if (totalFailures > 0) {
            logger.error(`🚨 Rotation completed with ${totalFailures} failures. Please check logs and intervene manually.`);
            process.exit(1);
        }

        logger.info('✨ Rotation completed successfully.');
    } catch (error) {
        logger.error('Fatal Rotation Error:', error);
        process.exit(1);
    }
}

// Allow running directly
if (process.argv[1] === import.meta.filename) {
    main();
}
