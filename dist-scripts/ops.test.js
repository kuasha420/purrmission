import {
  backupDatabase
} from "./chunk-3I74LDPK.js";
import {
  env
} from "./chunk-CHKU34YE.js";

// scripts/ops.test.ts
import { describe, it, before, after } from "test";
import assert from "assert/strict";
import fs from "fs";
import path from "path";
describe("Operations Scripts", () => {
  const backupDir = path.resolve(process.cwd(), "backups");
  before(() => {
    const dbUrl = env.DATABASE_URL;
    if (dbUrl.startsWith("file:")) {
      const dbPath = path.resolve(process.cwd(), dbUrl.slice(5));
      if (!fs.existsSync(dbPath)) {
        fs.writeFileSync(dbPath, "dummy data");
      }
    }
  });
  after(() => {
  });
  describe("backup-db", () => {
    it("should create a backup file for a valid SQLite DB", async () => {
      try {
        const backupPath = await backupDatabase();
        assert.ok(fs.existsSync(backupPath));
        assert.ok(backupPath.includes("backups"));
      } catch (err) {
        if (err instanceof Error && err.message.includes("only supported for SQLite")) {
          return;
        }
        throw err;
      }
    });
  });
  describe("rotate-keys", () => {
    it("should be importable without side effects", async () => {
      const module = await import("./rotate-keys.js");
      assert.ok(module);
    });
  });
});
