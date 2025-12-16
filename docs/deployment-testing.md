# Deployment Testing Guide

This guide explains how to safely test the deployment pipeline locally using `act` and `distrobox`.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) or [Podman](https://podman.io/)
- [Distrobox](https://distrobox.it/)
- [nektos/act](https://github.com/nektos/act)

## Local Simulation (Dry Run)

The `deploy.yml` workflow now supports a `workflow_dispatch` trigger with a `dry_run` input (default: `true`).
When enabled, no destructive actions (SSH/SCP) are performed. Instead, a simulation script runs on the runner to verify behavior.

### Running with Act

Use the helper script to run the workflow locally:

```bash
./scripts/ci/act-deploy.sh
```

This will:
1. Load secrets from `.github/act/deploy.secrets`
2. Load env from `.github/act/deploy.env`
3. Execute the `deploy` workflow in dry-run mode
4. Run the simulation step

To run a "real" (simulated) deploy inside Act:
```bash
./scripts/ci/act-deploy.sh false
```
**Note:** This will attempt to SSH/SCP if you provide valid credentials in `.secrets`. If you use the default dummy secrets, it will fail connection, which is expected.

## Distrobox Verification

To test the deployment logic against a realistic OS environment (simulating a fresh or existing server), use the Distrobox suite.

### Running the Suite

```bash
./scripts/ci/test-distrobox.sh
```

This script will:
1. Build the project (`yarn build`).
2. Create two containers: `purrmission-srv-fresh` and `purrmission-srv-existing` (defined in `distrobox.ini`).
3. **Fresh Server Test**:
   - Cleans the target directory.
   - Runs `simulate-deploy.sh` to verify full deployment from scratch.
4. **Existing Server Test**:
   - Populates the target directory with old artifacts and a `.env` file.
   - Runs `simulate-deploy.sh` to verify upgrade logic and `.env` preservation.

### Manual Debugging

You can enter the containers to debug manually:

```bash
distrobox enter purrmission-srv-fresh
```

Then run the simulation manually:
```bash
./scripts/ci/simulate-deploy.sh "apps/purrmission-bot/dist"
```

## Configuration

- **Distrobox Images**: Defined in `distrobox.ini`. Default: `node:lts-bookworm`.
- **Act Image**: Defined in `.actrc`.
- **Secrets**: Copy `.github/act/deploy.secrets.example` to `.github/act/deploy.secrets` and adjust if needed.
