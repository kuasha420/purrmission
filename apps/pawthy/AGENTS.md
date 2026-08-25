# Pawthy CLI Guide

Use these rules when you are working inside `apps/pawthy`.

## Structure

- `src/index.ts`: Commander entrypoint.
- `src/commands/`: CLI command implementations (`login`, `init`, `push`, `pull`, `tokens`).
- `src/config.ts`: config storage, token precedence, `.gitignore` helper, and `.pawthyrc` loading.

## Local rules

- Preserve the current config precedence: local `.pawthy/config.json` token overrides the global config-store token.
- `.pawthyrc` is repo-level project metadata and should remain commit-friendly.
- `.pawthy/` stores local auth state and must stay ignored.
- When changing auth or config flows, keep the `.gitignore` helper behavior working so local credentials do not get committed accidentally.
- Secret pull must use `POST /api/projects/:projectId/environments/:envId/secrets/reveal` with explicit `{ keys?: string[]; grantId?: string }` body; never issue `GET` to retrieve secrets.
- `pawthy tokens list` must never output plaintext, prefix, or digest.
- Respect `PAWTHY_API_URL` overrides and the persisted fallback API URL behavior in `src/config.ts`.

## Verification

- `pnpm --filter @psl-oss/pawthy test`
- Exercise the affected CLI flow manually when practical: `login`, `init`, `pull`, `push`, or `tokens`.
