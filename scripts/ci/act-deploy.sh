#!/bin/bash
set -euo pipefail

# Helper to run act for the deploy workflow
# Usage: ./scripts/ci/act-deploy.sh [dry_run=true|false]

DRY_RUN="${1:-true}"

echo "🎬 Running act for deploy workflow (dry_run=$DRY_RUN)..."

# Ensure secrets file exists
if [ ! -f .github/act/deploy.secrets ]; then
    echo "⚠️ .github/act/deploy.secrets not found. Copying example..."
    mkdir -p .github/act
    if [ -f .github/act/deploy.secrets.example ]; then
        cp .github/act/deploy.secrets.example .github/act/deploy.secrets
    else
        touch .github/act/deploy.secrets
    fi
fi

# Ensure env file exists
if [ ! -f .github/act/deploy.env ]; then
    echo "⚠️ .github/act/deploy.env not found. Copying example..."
    mkdir -p .github/act
    if [ -f .github/act/deploy.env.example ]; then
        cp .github/act/deploy.env.example .github/act/deploy.env
    else
        touch .github/act/deploy.env
    fi
fi

act workflow_dispatch \
    -W .github/workflows/deploy.yml \
    --secret-file .github/act/deploy.secrets \
    --env-file .github/act/deploy.env \
    --input dry_run="$DRY_RUN" \
    --artifact-server-path /tmp/act-artifacts
