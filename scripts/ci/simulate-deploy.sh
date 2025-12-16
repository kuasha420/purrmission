#!/bin/bash
set -euo pipefail

# Simulation of deployment steps on a local directory
# Usage: ./simulate-deploy.sh

TARGET_DIR="${SSH_TARGET:-/tmp/purrmission-deploy-sim}"

echo "🔧 Simulating Deployment to $TARGET_DIR"

# 1. Stop PM2 and clean (Simulated)
echo "📦 Step 1: Cleaning target..."
mkdir -p "$TARGET_DIR"

# Simulate preserving .env
if [ -f "$TARGET_DIR/.env" ]; then
    echo "   Preserving .env..."
    cp "$TARGET_DIR/.env" "$TARGET_DIR/.env.tmp"
fi

# Simulate rm -rf (be careful with variables!)
# We remove specific files as per deploy.yml
rm -rf "$TARGET_DIR/apps" \
       "$TARGET_DIR/dist" \
       "$TARGET_DIR/package.json" \
       "$TARGET_DIR/yarn.lock" \
       "$TARGET_DIR/.yarnrc.yml" \
       "$TARGET_DIR/ecosystem.config.cjs" \
       "$TARGET_DIR/dist-checksums.txt" \
       "$TARGET_DIR/prisma"

if [ -f "$TARGET_DIR/.env.tmp" ]; then
    mv "$TARGET_DIR/.env.tmp" "$TARGET_DIR/.env"
fi

# 2. Copy files
echo "📂 Step 2: Copying artifacts..."
# We need to replicate the 'source' list from scp-action:
# apps,package.json,yarn.lock,.yarnrc.yml,ecosystem.config.cjs,dist-checksums.txt,prisma
# The source context in local runner is current dir.

for item in apps package.json yarn.lock .yarnrc.yml ecosystem.config.cjs dist-checksums.txt prisma; do
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
echo "🧶 Step 4: Installing dependencies..."
# Ensure we use the correct yarn
if ! command -v corepack &> /dev/null; then
  echo "Enabling corepack..."
  corepack enable
fi

yarn install --immutable

echo "✅ Simulation Complete!"
