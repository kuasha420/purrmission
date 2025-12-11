---
trigger: model_decision
---

# Development Workflows

## Common Tasks

### Adding a New Command
1. Create file in `apps/purrmission-bot/src/commands/` (e.g., `mycommand.ts`)
2. Use this boilerplate:
   ```typescript
   import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
   import { Command } from "../types/command.js";

   export const data = new SlashCommandBuilder()
     .setName("mycommand")
     .setDescription("Does something cool");

   export async function execute(interaction: ChatInputCommandInteraction) {
     await interaction.reply("Hello!");
   }

   export default { data, execute } satisfies Command;
   ```
3. Add to command index if needed
4. Run `yarn deploy:commands` to register with Discord
5. Restart the bot

### Modifying Domain Logic
- Edit files in `apps/purrmission-bot/src/domain/`
- Update models in `models.ts`
- Update repository interfaces in `repositories.ts`
- Implement changes in repository implementations
- Update TOTP logic in `totp.ts`

### Adding API Endpoints
1. Add route to `apps/purrmission-bot/src/api/server.ts`
2. Define Zod schema for validation
3. Implement handler with proper error handling
4. Test with curl or Postman

## Code Standards

### TypeScript
- Strict mode enabled
- Explicit type annotations required
- Avoid `any` types (use `unknown` with type guards)
- Use defined interfaces for type safety
- File extensions (`.js`) required in imports (ESM)

### Error Handling
- Use custom error classes for domain-specific errors
- Add type guards for runtime validation
- Log errors with logger, not `console.error()`
- Provide user-friendly error messages

### Async/Await
- Used for all Discord API calls and file I/O
- Proper error handling in try-catch blocks
- Avoid callback-based patterns

### Import Patterns
- ES Modules only (`import`/`export`)
- Use `.js` extensions even for `.ts` files
- Organize imports: external → internal → types

## Testing

### Running Tests
```bash
yarn test              # Run all tests
yarn test:watch        # Watch mode
yarn test:coverage     # Coverage report
```

### Writing Tests
- Test framework: TBD (Vitest recommended)
- Unit tests for business logic
- Integration tests for repositories
- Mock Discord interactions

## Debugging

### Common Issues

**"Module not found"**
- Missing `.js` extension in import
- Fix: Add `.js` to all relative imports

**"Cannot find name"**
- TypeScript type error
- Fix: Add proper type annotations

**Command not registered**
- Slash command not deployed
- Fix: Run `yarn deploy:commands`

### Logging
- Use logger utility instead of `console.log`
- Repository operations logged in development
- API requests logged by Fastify

## Agent Guidelines

### File Updates
- **.agent/** files: Use command line tools (`cat`, `sed`) or full file rewrites. Do NOT use partial replacement tools.

### Commit Practices
- **Atomic Commits**: Prefer small, focused commits that address a single logical change.
- **Descriptive Messages**: Write clear, concise commit messages explaining the "why" and "what".

### Temporary Files
- **Workspace Hygiene**: Never save temporary files in the root or source directories.
- **Location**: Always use the `tmp/` directory (create if needed).
- **Cleanup**: Delete temporary files when no longer needed.
