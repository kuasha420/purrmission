---
trigger: always_on
---

# 📝 Coding Standards & Agent Behavior

## 1. Safety First
- **Filesystem**: Verify file paths with `find_by_name` or `list_dir` before editing.
- **Testing**: Always implement 'QA Checklist' items manually if possible, or script them.
- **Dependencies**: 
    - Do not add new npm packages without explicit user approval.
    - **MUST** run `pnpm audit` before adding/upgrading dependencies to check for CVEs.
- **Git Hygiene**:
    - **NEVER** commit directly to `main`. Always use a feature branch.
    - **Check Branch**: Run `git status` before every `git add/commit` sequence.
    - **Granularity**: focused commits only. Separation of concerns (Deps vs Code vs Config). No "misc" or "wip".

## 2. Code Style
- **TypeScript**: Strict mode enabled. No `any` without explicit justification.
- **Architecture**: Follow the Domain functions/Repo pattern.
    - Domain logic in `src/domain/`.
    - Data persistence in `src/domain/repositories.ts` (Prisma implementations).
    - API handlers in `src/http/`.
    - Discord commands in `src/discord/commands/`.
- **Async/Await**: Use for all I/O. Proper error handling with try/catch where appropriate.
- **Validation**: Use Zod for all input validation (API schemas, Command inputs).

## 3. Communication
- **Updates**: Provide concise status updates (Task Boundary).
- **Errors**: Report errors clearly; do not hide them.
- **Decisions**: Reference `architecture.md` for architectural decisions.

## 4. Documentation Discipline
- **Freshness**: Always keep docs, agent rules, READMES, and comments up to date.
- **The 5-Minute Rule**: Before every PR, take 5 minutes to reflect on changes. Update any impacted documentation. Verify that all open threads/issues are addressed.
