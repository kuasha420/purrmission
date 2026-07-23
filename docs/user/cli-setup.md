# Pawthy CLI Setup

This guide describes how to install and use the `pawthy` CLI tool for Credential Sync operations.

## Quick Start (npx)

The easiest way to run `pawthy` (especially for CI/CD or one-off tasks) is using `npx`. No installation required!

```bash
# Check version
npx @psl-oss/pawthy --version

# Log in
npx @psl-oss/pawthy login --url https://purrmission.internal

# Pull secrets
npx @psl-oss/pawthy pull
```

## Installation

### Global Installation

For frequent use, install globally:

```bash
npm install -g @psl-oss/pawthy
```

Then run commands directly:

```bash
pawthy push
```

### Project Installation

To pin a specific version for your project:

```bash
npm install -D @psl-oss/pawthy
```

Run via npm scripts or `npx`:

```bash
npx pawthy pull
```

## Troubleshooting

### "Package not found"

Ensure you are using the correct scope `@psl-oss`.
