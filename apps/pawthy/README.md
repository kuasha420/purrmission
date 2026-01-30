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

---

## Getting Started

### Step 1: Authenticate

Log in to your Purrmission account using Discord Device Flow authentication.

```bash
pawthy login
```

Follow the on-screen instructions:
1. Run the displayed Discord command (`/purrmission cli-login code:XXXX`)
2. The CLI will automatically detect approval and save your session

**Options:**

| Flag | Description |
|------|-------------|
| `-l, --local` | Store session in `.pawthy/config.json` (per-project) instead of global config |

**Example (per-project auth):**

```bash
pawthy login --local
```

> **Tip:** Use `--local` when working with multiple Purrmission accounts or when you need project-specific credentials.

---

### Step 2: Initialize a Project

Navigate to your project root and link it to a Purrmission project and environment.

```bash
pawthy init
```

This interactive command will:
1. Fetch available projects from your account
2. Let you select a project (or create a new one)
3. Let you select an environment (Production, Staging, etc.)
4. Save the configuration to `.pawthyrc`

---

### Step 3: Push Secrets (Project Owner)

If you're the project owner, upload your local secrets to establish the baseline.

```bash
pawthy push
```

**Options:**

| Flag | Description |
|------|-------------|
| `-f, --file <path>` | Source `.env` file path (default: `.env`) |
| `--force` | Skip confirmation prompt |

**Example:**

```bash
pawthy push -f .env.production --force
```

> **Note:** Push updates existing values but does not remove secrets that exist remotely.

---

### Step 4: Pull Secrets

Fetch secrets from Purrmission and save them locally.

```bash
pawthy pull
```

**Options:**

| Flag | Description |
|------|-------------|
| `-f, --file <path>` | Output file path (default: `.env`) |

**Example:**

```bash
pawthy pull -f .env.local
```

---

## Multi-User & Team Workflows

Purrmission uses a **Guardian-based approval system** for secure secret access.

### Understanding Roles

| Role | Description |
|------|-------------|
| **Owner** | Project creator. Full access to secrets. Can add/remove guardians. |
| **Guardian** | Trusted team member. Can approve/deny access requests. Has immediate access to secrets. |
| **Requester** | Any authenticated user. Must request approval to access secrets. |

### Workflow: Adding Team Members

1. **Project Owner** creates the project and pushes initial secrets
2. **Owner** adds team members as Guardians via Discord:
   ```
   /purrmission guardian add resource-id:<resource-id> user:@teammate
   ```
3. **Guardians** can now:
   - Pull secrets directly (no approval needed)
   - Approve/deny requests from other users

### Workflow: Requesting Access (Non-Guardian)

When a non-guardian user runs `pawthy pull`:

1. CLI shows: `⏳ Access Pending Approval`
2. A Discord DM is sent to all Guardians with Approve/Deny buttons
3. Once approved, the user can re-run `pawthy pull` to get secrets

**Example flow:**

```bash
# New team member runs pull
$ pawthy pull
Fetching secrets from Purrmission...

⏳ Access Pending Approval
Secret access is pending approval in Discord

Please run this command again once your request has been approved in Discord.

# After guardian approves in Discord...
$ pawthy pull
✅ Successfully pulled 10 secrets to .env
```

### Workflow: Approving Requests (Guardian)

Guardians receive a Discord DM with:
- **Requester**: Who is requesting access
- **Reason**: Context (e.g., "CLI pull request for myproject:Production")
- **Approve/Deny buttons**: One-click decision

---

## Configuration

### Project Configuration (`.pawthyrc`)

Located in your project root, stores project-environment binding:

```json
{
  "projectId": "uuid-string",
  "envId": "uuid-string"
}
```

**Version Control:** `.pawthyrc` **should be committed** to your repository:
- Ensures all team members connect to the same project/environment
- Eliminates need for each developer to run `pawthy init`
- UUIDs are not secrets—access is controlled by Guardian approval

> **Note:** Future versions will support `.pawthyrc.local` for per-developer environment overrides.

### Local Session (`.pawthy/config.json`)

When using `--local` login, credentials are stored per-project:

```
.pawthy/
└── config.json    # Contains auth token (DO NOT COMMIT)
```

> **Security:** Add `.pawthy/` to `.gitignore` to avoid committing credentials.

### Global Configuration

Default session storage location:
- **Linux/macOS:** `~/.config/configstore/pawthy.json`
- **Windows:** `%APPDATA%/configstore/pawthy.json`

---

## Environment Variables

| Variable | Description |
|----------|-------------|

| `PAWTHY_API_URL` | Override the Purrmission server URL (default: `https://purrmission.infra.purrfecthq.com`). Supports `.env` files. |


---

## Command Reference

| Command | Description |
|---------|-------------|
| `pawthy login` | Authenticate with Discord Device Flow |
| `pawthy init` | Link current directory to a project/environment |
| `pawthy push` | Upload local `.env` to Purrmission |
| `pawthy pull` | Download secrets to local `.env` |
| `pawthy --version` | Display CLI version |
| `pawthy --help` | Show help |

---

## Troubleshooting

### Permission Denied / Access Pending

If you're not a Guardian or Owner:
1. Your `pull` request triggers an approval workflow
2. Wait for a Guardian to approve via Discord
3. Re-run `pawthy pull` after approval

### Session Expired (401 Error)

Tokens expire after 90 days. Re-authenticate:

```bash
pawthy login
```

### Wrong Project/Environment

Re-initialize your project link:

```bash
pawthy init
```

### Cached Server URL

If switching between local dev and production, you may need to clear the global configuration file.

Refer to the "Global Configuration" section above for the file path on your OS:
- **Linux/macOS:** `~/.config/configstore/pawthy.json`
- **Windows:** `%APPDATA%\configstore\pawthy.json`

After deleting the file, log in again:

```bash
pawthy login
```

---

## Security Best Practices

1. **Never commit `.pawthy/`** - Add to `.gitignore`
2. **Use `--local` for sensitive projects** - Isolates credentials per-project
3. **Rotate access periodically** - Revoke unused Guardian access
4. **Review approval requests carefully** - Check requester identity before approving

---

Built with ❤️ by the Purrmission Team.
