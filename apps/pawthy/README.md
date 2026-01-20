# Pawthy CLI

**Credential Sync for Purrmission.**

`pawthy` is the command-line interface for the Purrmission secret management system. It allows developers to securely sync environment variables and secrets between their local development environment and the Purrmission central store.

## Installation

### Global Installation (Recommended)

Install `pawthy` globally to use it across all your projects.

```bash
npm install -g @psl-oss/pawthy
# or
pnpm add -g @psl-oss/pawthy
```

### Run via NPX (No Install)

You can also run commands directly without installation:

```bash
npx @psl-oss/pawthy <command>
```

## Usage

### 1. Authenticate

First, log in to your Purrmission account. This uses a secure Device Flow authentication with Discord.

```bash
pawthy login
```

Follow the on-screen instructions to authorize the CLI via Discord.

### 2. Initialize a Project

Navigate to your project root and link it to a Purrmission project and environment.

```bash
pawthy init
```

This will guide you through selecting a project and environment, saving the configuration to `.pawthyrc`.

### 3. Pull Secrets

Fetch secrets from Purrmission and save them to your local `.env` file.

```bash
pawthy pull
```

**Options:**

- `-f, --file <path>`: Specify the output file path (default: `.env`).

**Example:**

```bash
pawthy pull -f .env.local
```

### 4. Push Secrets

Upload your local secrets to Purrmission. **Note:** This updates existing values in the remote environment.

```bash
pawthy push
```

**Options:**

- `-f, --file <path>`: Specify the source `.env` file path (default: `.env`).
- `--force`: Skip the confirmation prompt.

**Example:**

```bash
pawthy push --force
```

## Configuration

The CLI uses a `.pawthyrc` JSON file in your project root to store context:

```json
{
  "projectId": "uuid-string",
  "envId": "uuid-string"
}
```

## Troubleshooting

- **Permission Denied**: Ensure you are a **Guardian** or **Owner** of the resource linked to the environment. If not, `pawthy pull` may trigger an approval workflow request.
- **Session Expired**: Tokens are short-lived. Run `pawthy login` again if you encounter 401 errors.

---

Built with ❤️ by the Purrmission Team.
