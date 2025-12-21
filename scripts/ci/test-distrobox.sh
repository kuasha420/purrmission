#!/bin/bash
set -euo pipefail

# Orchestrator for Distrobox integration testing
# Requires distrobox to be installed on host.

echo "🐳 Starting Distrobox Verification Suite"

# Ensure we have a build artifact to test with
echo "🏗️ Building project..."
pnpm build

# Create containers if they don't exist
# We use the ini file
echo "📦 Creating/Starting containers..."
distrobox create --file distrobox.ini || true

# Helper to run commands in distrobox
run_in() {
    local container="$1"
    shift
    echo "▶️ Running in $container: $*"
    # We assume the project root is mounted (default behavior of distrobox)
    # We navigate to current directory
    local cwd=$(pwd)
    distrobox enter "$container" -- sh -c "cd '$cwd' && $*"
}

# 1. Test Fresh Server
echo "🧪 Testing Fresh Server..."
run_in purrmission-srv-fresh "./scripts/ci/setup-fresh.sh"
run_in purrmission-srv-fresh "./scripts/ci/simulate-deploy.sh"

# 2. Test Existing Server
echo "🧪 Testing Existing Server..."
run_in purrmission-srv-existing "./scripts/ci/setup-existing.sh"
run_in purrmission-srv-existing "./scripts/ci/simulate-deploy.sh"

echo "✅ Distrobox Verification Complete!"
