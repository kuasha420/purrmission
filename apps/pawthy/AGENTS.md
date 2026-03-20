# Pawthy CLI Guide

Use these rules when you are working inside `apps/pawthy`.

## Structure

- `src/index.ts`: Commander entrypoint.
- `src/commands/`: CLI command implementations.
- `src/config.ts`: config storage, token precedence, `.gitignore` helper, and `.pawthyrc` loading.

## Local rules

- Preserve the current config precedence: local `.pawthy/config.json` token overrides the global config-store token.
- `.pawthyrc` is repo-level project metadata and should remain commit-friendly.
- `.pawthy/` stores local auth state and must stay ignored.
- When changing auth or config flows, keep the `.gitignore` helper behavior working so local credentials do not get committed accidentally.
- Respect `PAWTHY_API_URL` overrides and the persisted fallback API URL behavior in `src/config.ts`.

## Verification

- `pnpm --filter @psl-oss/pawthy test`
- Exercise the affected CLI flow manually when practical: `login`, `init`, `pull`, or `push`.
