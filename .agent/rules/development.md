---
trigger: always_on
---

# 🛠️ Development Standards & Workflows

## 🛡️ Guardrails & Safety First

1. **Branching Strategy**: **NEVER** commit directly to `main` or `master`. Always create feature (`feat/`), bugfix (`fix/`), or chore (`chore/`) branches.
2. **Environment & Sync**: Run `git status` to ensure a clean slate before any commits. Propose gitignoring newly discovered temporary files instead of committing them.
3. **Dependencies & CVEs**: Do not install npm packages without approval. Run `pnpm audit` before upgrades/additions to check for vulnerability alerts.
4. **Fail Early**: Stop execution immediately on any non-zero exit code. Never ignore lint, test, or build errors.

## 📝 Code Standards & TypeScript Guidelines

- **Strict TypeScript**: Do not use `any`. Use `unknown` with type guards.
- **ES Modules (ESM)**: All imports must end with `.js` extensions (even for `.ts` files).
- **Architecture & Layering**: Follow the Domain-Repository-Service architecture:
  - Domain logic in `apps/purrmission-bot/src/domain/`.
  - Data persistence strictly encapsulated in repositories under `apps/purrmission-bot/src/domain/repositories.ts` (Prisma implementations). Never access the database directly in routes/commands.
  - API handlers in `apps/purrmission-bot/src/http/`.
  - Discord slash commands in `apps/purrmission-bot/src/discord/commands/`.
  - Services injected via the `Services` container.
- **Validation**: Use Zod for all input validation (API request schemas, slash command inputs).
- **Async/Await**: Use for all I/O and Discord API calls. Implement proper try/catch error handling.
- **Error Handling**: Use domain-specific custom error classes and type guards for narrowing. Log errors via the shared logger; do not use `console.log`.

---

## 🚀 Key Workflows

### 1. Adding a Slash Command

Create `apps/purrmission-bot/src/discord/commands/mycommand.ts` using this boilerplate:

```typescript
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { Command } from '../types/command.js';
import type { Services } from '../../domain/services.js';

export const data = new SlashCommandBuilder()
  .setName('mycommand')
  .setDescription('Boilerplate desc');

export async function execute(interaction: ChatInputCommandInteraction, services: Services) {
  await interaction.reply('Hello World!');
}

export default { data, execute } satisfies Command;
```

After creating, run `pnpm discord:deploy-commands` to register it with Discord.

### 2. Modifying DB Schemas & Domain Logic

- Edit `prisma/schema.prisma` if schema changes.
- Run `pnpm prisma:migrate:dev` to generate and apply migrations.
- Run `pnpm prisma:generate` to update the Prisma Client.
- Update interfaces and classes under `src/domain/repositories.ts`.

### 3. Verification & Testing

We use Node.js's native test runner (`node:test`) with `tsx`. Place tests adjacent to the source code (e.g., `totp.test.ts` next to `totp.ts`).

- **Run all tests**: `pnpm test`
- **Run specific test file**: `node --import tsx --test apps/purrmission-bot/src/domain/totp.test.ts`
- **Format codebase**: `pnpm format`
- **Lint codebase**: `pnpm lint`
