# Design Doc: Purrmission Credential Sync

## 1. Overview
A new capability to synchronize development credentials (secrets, .env variables, API keys) across machines using a centralized Purrmission server. This involves a new CLI tool (`purrmission`) and enhancements to the existing generic HTTP API.

## 2. Goals
- **Centralized Secret Management**: Store `.env` vars securely in Purrmission.
- **Developer Experience**: Simple CLI to `push` and `pull` secrets.
- **Access Control**: Use existing Guardian system to control who can pull secrets.
- **Automation**: Unattended mode for CI/CD or setup scripts.
- **Interactive**: TUI for easy onboarding.

## 3. Architecture

### 3.1. Components
1.  **Pawthy CLI (`apps/pawthy`)**:
    - Node.js CLI (TypeScript).
    - Libraries: `commander` (args), `inquirer`/`prompts` (TUI), `dotenv` (parsing).
    - Function: Authenticates with Bot, reads/writes local `.env`, calls API.
2.  **Purrmission Bot/API (`apps/purrmission-bot`)**:
    - Existing Fastify API extension.
    - New Endpoints for handling "Projects" and "Secrets".

### 3.2. Data Model Mapping
We will leverage the existing robust domain models:

| Concept | Existing Model | Notes |
| :--- | :--- | :--- |
| **Project Environment** | `Resource` | Name format: `project-name:env` (e.g., `web-app:dev`). `mode` controls approval policy. |
| **Secret/Env Var** | `ResourceField` | `name` = Key (e.g. `DATABASE_URL`), `value` = Encrypted Value. |
| **Developer/User** | `Guardian` | Access control links Discord User to Resource. |

### 3.3. Authentication Flow (CLI <-> API)
**Challenge**: How does the CLI verify it's a specific Discord user?
**Solution: "Device Flow" or "Command-based Token"**
1. User runs `pawthy login`.
2. CLI generates a unique `session_code`.
3. CLI asks user to run `/purrmission cli-login code:<session_code>` in Discord.
4. Bot verifies user in Discord, associates `session_code` with `discordUserId`, and issues a long-lived **API Token**.
5. CLI polls/receives the Token and stores it in `~/.pawthy/config`.

**Unattended**:
- User generates a static **Service Token** via Discord command (e.g. `/purrmission token create`).
- Script uses `PURRMISSION_TOKEN` env var.

## 4. Workflows

### 4.1. Initialization (`pawthy init`)
1. TUI asks for Project Name (e.g., "my-website") and Environment (e.g., "dev").
2. CLI checks if `Resource` "my-website:dev" exists.
    - If no: Calls API to crate it (User must be Owner).
    - If yes: Checks permissions.
3. Creates local `.pawthyrc` linking current dir to that Resource ID.

### 4.2. Push (`pawthy push`)
1. parses `.env` file.
2. Encrypts? (Optional: Client-side encryption would be best, but for MVP, TLS + Server-side encryption is standard).
3. Sends Key/Value pairs to API.
4. API updates `ResourceField`s (upsert).

### 4.3. Pull (`pawthy pull`)
1. Calls API to list fields for Resource.
2. API enforces **Approval Flow**:
    - If Resource is `OPEN` (or user is Owner?), return data immediately.
    - If Resource requires approval (`ONE_OF_N`), API returns "Pending Approval" status.
    - Sending a pull request triggers an `ApprovalRequest` to Guardians in Discord.
    - CLI waits or user re-runs command.
3. Once approved/allowed, API returns decrypted secrets.
4. CLI writes to `.env`.

## 5. API Endpoints
- `POST /api/auth/token` - Exchange session code for token.
- `GET /api/projects` - List accessible resources.
- `POST /api/projects` - Create new resource.
- `GET /api/projects/:id/secrets` - Get all fields (governed by approval).
- `PUT /api/projects/:id/secrets` - Batch upsert fields.

## 6. Security Implementation
- **Transport**: HTTPS required.
- **Storage**: Existing AES-256-GCM at rest.
- **Access**: API endpoints mapped to `Guardian` logic.
