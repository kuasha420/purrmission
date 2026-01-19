# Pawthy CLI 🐾

**Pawthy** is the official Credential Sync CLI for the **Purrmission** access control system. It allows developers to securely request and retrieve secrets (env vars) directly into their local environment, authenticated via Discord.

## Features

- **Discord-based Authentication**: Secure device flow using your Discord credentials.
- **Secure Retrieval**: Secrets are encrypted at rest and transmitted securely.
- **Project-scoped Access**: Pull secrets for specific Projects and Environments.
- **Auto-Approval**: Integrates with Purrmission's Guardian approval workflow.

## Installation

```bash
npm install -g @psl-oss/pawthy
# OR run via npx
npx @psl-oss/pawthy login
```

## Configuration

Pawthy uses a `.pawthyrc` file in your project root to identify the context.

Example `.pawthyrc`:
```json
{
  "apiUrl": "https://purrmission.your-company.com",
  "projectId": "your-project-uuid",
  "envId": "your-environment-uuid"
}
```

You can also set the API URL via environment variable `PAWTHY_API_URL`.

## Usage

### 1. Authenticate

Start the device login flow. You will be prompted to authenticate via a Discord command or URL.

```bash
pawthy login
```

### 2. Pull Secrets

Retrieve secrets for the configured environment and write them to a `.env` file.

```bash
pawthy pull
```

If your request requires approval, `pull` will notify you to wait for a Guardian to approve the request in Discord. Once approved, run `pull` again.

## Development

```bash
pnpm install
pnpm build
node dist/index.js <command>
```

## License

MIT
