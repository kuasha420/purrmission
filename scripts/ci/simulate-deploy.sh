#!/bin/bash
set -euo pipefail

# Simulation of deployment steps on a local directory
# Usage: ./simulate-deploy.sh

TARGET_DIR="${SSH_TARGET:-/tmp/purrmission-deploy-sim}"

echo "🔧 Simulating Deployment to $TARGET_DIR"

# 1. Stop PM2 and clean (Simulated)
echo "📦 Step 1: Cleaning target..."
mkdir -p "$TARGET_DIR"

# Simulate preserving .env and persistent data (matching deploy.yml exactly)
# Use the same find command as in deploy.yml
echo "   Cleaning with preservation rules..."
find "$TARGET_DIR" -mindepth 1 -maxdepth 1 \
  ! -name '.env*' \
  ! -name '*.db' \
  ! -name '*.db-*' \
  ! -name '*.sqlite' \
  ! -name '*.sqlite3' \
  ! -name '*.sqlite-*' \
  ! -name '*.sqlite3-*' \
  ! -name 'data' \
  -exec rm -rf {} +

# Verify preserved files still exist
echo "   Verifying persistence..."
PRESERVED_FILES=(
    ".env"
    "production.db"
    "production.db-wal"
    "production.db-shm"
)

for pf in "${PRESERVED_FILES[@]}"; do
    if [ -e "$TARGET_DIR/$pf" ]; then
        echo "   ✓ Preserved: $pf"
    else
        echo "   ⚠ Not found (may not have been created): $pf"
    fi
done

if [ -d "$TARGET_DIR/data" ]; then
    echo "   ✓ Preserved: data/"
fi

# 2. Copy files
echo "📂 Step 2: Copying artifacts..."
# We need to replicate the 'source' list from scp-action:
# apps,package.json,pnpm-lock.yaml,pnpm-workspace.yaml,ecosystem.config.cjs,dist-checksums.txt,prisma
# The source context in local runner is current dir.

for item in apps package.json pnpm-lock.yaml pnpm-workspace.yaml ecosystem.config.cjs dist-checksums.txt prisma; do
    if [ -e "$item" ]; then
        cp -r "$item" "$TARGET_DIR/"
    else
        echo "⚠️ Warning: $item not found in source!"
    fi
done

# 3. Verify Integrity
echo "🛡️ Step 3: Verifying integrity..."
cd "$TARGET_DIR"
if [ -f "dist-checksums.txt" ]; then
    sha256sum -c dist-checksums.txt
else
    echo "❌ dist-checksums.txt missing!"
    exit 1
fi

# 4. Install Dependencies
echo "📦 Step 4: Installing dependencies..."
# Ensure we use pnpm
if ! command -v corepack &> /dev/null; then
  echo "Enabling corepack..."
  corepack enable
fi
corepack prepare pnpm@9.15.1 --activate

pnpm install --frozen-lockfile

echo "✅ Simulation Complete!"
