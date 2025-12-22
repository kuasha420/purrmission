import {
  env
} from "./chunk-CHKU34YE.js";

// scripts/backup-db.ts
import fs from "fs";
import path from "path";

// apps/purrmission-bot/src/logging/logger.ts
function formatTimestamp() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function formatMessage(level, message, meta) {
  const timestamp = formatTimestamp();
  const metaStr = meta !== void 0 ? ` ${JSON.stringify(meta)}` : "";
  return `[${timestamp}] [${level}] ${message}${metaStr}`;
}
var logger = {
  debug(message, meta) {
    console.debug(formatMessage("DEBUG", message, meta));
  },
  info(message, meta) {
    console.info(formatMessage("INFO", message, meta));
  },
  warn(message, meta) {
    console.warn(formatMessage("WARN", message, meta));
  },
  error(message, meta) {
    console.error(formatMessage("ERROR", message, meta));
  }
};

// scripts/backup-db.ts
async function backupDatabase() {
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl.startsWith("file:")) {
    logger.warn('\u26A0\uFE0F Backup skipped: DATABASE_URL does not start with "file:", assuming non-SQLite DB.');
    throw new Error("Automated backup only supported for SQLite (file: protocol)");
  }
  if (!dbUrl.startsWith("file:")) {
    throw new Error("backup-db script only supports SQLite (DATABASE_URL must start with file:)");
  }
  let dbPath = dbUrl.replace(/^file:/, "");
  if (dbPath.startsWith("///")) {
    dbPath = dbPath.slice(2);
  } else if (dbPath.startsWith("//")) {
    dbPath = dbPath.slice(1);
  }
  dbPath = dbPath.split("?")[0];
  const absoluteDbPath = path.resolve(process.cwd(), dbPath);
  if (!fs.existsSync(absoluteDbPath)) {
    throw new Error(`Database file not found at: ${absoluteDbPath}`);
  }
  const backupDir = path.resolve(process.cwd(), "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const filename = path.basename(absoluteDbPath);
  const backupName = `${path.parse(filename).name}-${timestamp}${path.parse(filename).ext}`;
  const backupPath = path.join(backupDir, backupName);
  logger.info(`\u{1F4E6} Backing up database to: ${backupPath}`);
  fs.copyFileSync(absoluteDbPath, backupPath);
  logger.info("\u2705 Backup completed successfully.");
  return backupPath;
}
if (process.argv[1] === import.meta.filename) {
  backupDatabase().catch((err) => {
    console.error("\u274C Backup failed:", err);
    process.exit(1);
  });
}

export {
  logger,
  backupDatabase
};
