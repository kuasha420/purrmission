import {
  decryptValue,
  encryptValue
} from "./chunk-NS5LOM5Y.js";
import {
  backupDatabase,
  logger
} from "./chunk-3I74LDPK.js";
import {
  env
} from "./chunk-CHKU34YE.js";

// apps/purrmission-bot/src/infra/prismaClient.ts
import { PrismaClient } from "@prisma/client";
var prisma = null;
function getPrismaClient() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

// scripts/rotate-keys.ts
var HEX_REGEX = /^[0-9a-fA-F]{64}$/;
function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const batchIndex = args.indexOf("--batch-size");
  let batchSize = 100;
  if (batchIndex !== -1) {
    const val = args[batchIndex + 1];
    if (!val || val.startsWith("--")) {
      throw new Error("Missing or invalid value for --batch-size");
    }
    batchSize = parseInt(val, 10);
    if (isNaN(batchSize) || batchSize <= 0) {
      throw new Error("Invalid value for --batch-size. Must be a positive number.");
    }
  }
  let oldKeyHex = process.env.ENCRYPTION_KEY_OLD;
  const fromKeyIndex = args.indexOf("--from-key");
  if (fromKeyIndex !== -1) {
    const val = args[fromKeyIndex + 1];
    if (!val || val.startsWith("--")) {
      throw new Error("Missing or invalid value for --from-key");
    }
    oldKeyHex = val;
  }
  if (!oldKeyHex && env.ENCRYPTION_KEY) {
    logger.info("\u2139\uFE0F No old key specified, using current ENCRYPTION_KEY as old key.");
    oldKeyHex = env.ENCRYPTION_KEY;
  }
  let newKeyHex = process.env.ENCRYPTION_KEY_NEW;
  const toKeyIndex = args.indexOf("--to-key");
  if (toKeyIndex !== -1) {
    const val = args[toKeyIndex + 1];
    if (!val || val.startsWith("--")) {
      throw new Error("Missing or invalid value for --to-key");
    }
    newKeyHex = val;
  }
  if (!newKeyHex) {
    logger.info("\u2139\uFE0F No new key specified, using current ENCRYPTION_KEY as new key.");
    newKeyHex = env.ENCRYPTION_KEY;
  }
  if (!oldKeyHex || !HEX_REGEX.test(oldKeyHex)) {
    throw new Error("Old Key must be a valid 32-byte hex string. Provide via --from-key or ENCRYPTION_KEY_OLD.");
  }
  if (!newKeyHex || !HEX_REGEX.test(newKeyHex)) {
    throw new Error("New Key must be a valid 32-byte hex string. Provide via --to-key or ENCRYPTION_KEY_NEW.");
  }
  return {
    dryRun,
    batchSize,
    oldKey: Buffer.from(oldKeyHex, "hex"),
    newKey: Buffer.from(newKeyHex, "hex")
  };
}
async function rotateEncryptedModel(modelDelegate, modelName, encryptedFieldName, displayFieldName, config) {
  logger.info(`\u{1F504} Processing ${modelName}...`);
  const total = await modelDelegate.count();
  let processed = 0;
  let updated = 0;
  let verified = 0;
  let failed = 0;
  for (let i = 0; i < total; i += config.batchSize) {
    const batch = await modelDelegate.findMany({
      take: config.batchSize,
      skip: i
    });
    for (const item of batch) {
      try {
        const ciphertext = item[encryptedFieldName];
        if (!ciphertext) {
          processed++;
          continue;
        }
        let plaintext;
        try {
          plaintext = decryptValue(ciphertext, config.oldKey);
        } catch (err) {
          const looksLikeV1 = ciphertext.startsWith("v1:") && ciphertext.split(":").length === 4;
          const isExplicitPlaintext = ciphertext.startsWith("otpauth://");
          if (!looksLikeV1 || isExplicitPlaintext) {
            logger.warn(`\u26A0\uFE0F  Found likely unencrypted data for ${modelName} ${item.id} (${item[displayFieldName]}). Encrypting now.`);
            plaintext = ciphertext;
          } else {
            throw err;
          }
        }
        const newCiphertext = encryptValue(plaintext, config.newKey);
        if (newCiphertext !== ciphertext) {
          updated++;
          if (!config.dryRun) {
            await modelDelegate.update({
              where: { id: item.id },
              data: { [encryptedFieldName]: newCiphertext }
            });
            const check = await modelDelegate.findUnique({ where: { id: item.id } });
            if (check && decryptValue(check[encryptedFieldName], config.newKey) === plaintext) {
              verified++;
            } else {
              logger.error(`\u274C Verification failed for ${modelName} ${item.id}`);
              failed++;
            }
          }
        } else {
          verified++;
        }
      } catch (err) {
        logger.error(`\u274C Failed to process ${modelName} ${item.id}: ${err}`);
        failed++;
      }
      processed++;
    }
  }
  logger.info(`\u2705 ${modelName}: Scanned ${processed}, Updated ${updated}, Verified ${verified}, Failed ${failed}`);
  return failed;
}
async function main() {
  try {
    const config = parseArgs();
    logger.info("\u{1F510} Starting Key Rotation / Re-encryption");
    logger.info(`Dry Run: ${config.dryRun}`);
    logger.info(`Batch Size: ${config.batchSize}`);
    if (config.oldKey.equals(config.newKey)) {
      logger.info("\u2139\uFE0F Old Key matches New Key. This operation will update ciphertext formats to v1.");
    } else {
      logger.info("\u26A0\uFE0F ROTATING KEYS: Old and New keys are different.");
    }
    if (!config.dryRun) {
      await backupDatabase();
    }
    const prisma2 = getPrismaClient();
    let totalFailures = 0;
    totalFailures += await rotateEncryptedModel(
      prisma2.tOTPAccount,
      "TOTPAccount",
      "secret",
      "accountName",
      config
    );
    totalFailures += await rotateEncryptedModel(
      prisma2.resourceField,
      "ResourceField",
      "value",
      "name",
      config
    );
    if (totalFailures > 0) {
      logger.error(`\u{1F6A8} Rotation completed with ${totalFailures} failures. Please check logs and intervene manually.`);
      process.exit(1);
    }
    logger.info("\u2728 Rotation completed successfully.");
  } catch (error) {
    logger.error("Fatal Rotation Error:", error);
    process.exit(1);
  }
}
if (process.argv[1] === import.meta.filename) {
  main();
}
