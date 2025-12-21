#!/bin/bash
set -euo pipefail

# Setup an environment that looks like an existing deployment
TARGET_DIR="${SSH_TARGET:-/srv/purrmission}"

echo "🧹 Setting up EXISTING environment in $TARGET_DIR..."

# Reset first
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

# Create dummy .env
echo "Creating .env..."
echo "DATABASE_URL=file:./test.db" > "$TARGET_DIR/.env"
echo "SECRET=existing_secret" >> "$TARGET_DIR/.env"

# Create dummy artifacts that should be cleaned up
echo "Creating dummy artifacts..."
mkdir -p "$TARGET_DIR/apps/purrmission-bot/dist"
touch "$TARGET_DIR/apps/purrmission-bot/dist/old-code.js"
touch "$TARGET_DIR/package.json"
touch "$TARGET_DIR/yarn.lock"
echo "files..." > "$TARGET_DIR/dist-checksums.txt"

# Create a file that should NOT be touched if it exists (e.g. database if strict)
# But our deploy cleans everything except .env mostly.
# deploy.yml says: "Remove old ... but preserve .env and potential sqlite db"
# Actually the rm -rf list is specific:
# rm -rf apps dist package.json yarn.lock .yarnrc.yml ecosystem.config.cjs dist-checksums.txt prisma

# Create SQLite databases that should survive deployment
echo "Creating persistent database fixtures..."
touch "$TARGET_DIR/production.db"
touch "$TARGET_DIR/production.db-wal"   # WAL mode sidecar
touch "$TARGET_DIR/production.db-shm"   # WAL mode sidecar
touch "$TARGET_DIR/backup.sqlite3"
touch "$TARGET_DIR/backup.sqlite3-wal"
touch "$TARGET_DIR/backup.sqlite3-shm"

# Create data directory with nested database
mkdir -p "$TARGET_DIR/data"
touch "$TARGET_DIR/data/app.sqlite"
echo "test data" > "$TARGET_DIR/data/cache.json"

echo "✅ Existing environment ready at $TARGET_DIR"
