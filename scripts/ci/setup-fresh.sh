#!/bin/bash
set -euo pipefail

# Setup a fresh, empty target directory
TARGET_DIR="${SSH_TARGET:-/srv/purrmission}"

echo "🧹 Setting up FRESH environment in $TARGET_DIR..."
# Ensure parent exists
mkdir -p "$(dirname "$TARGET_DIR")"

# Clean completely
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

echo "✅ Fresh environment ready at $TARGET_DIR"
