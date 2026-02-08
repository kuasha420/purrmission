# Contributing to Purrmission

We welcome contributions! Please follow these guidelines to ensure a smooth process.

## Development Workflow

1.  **Fork and Clone**: Fork the repository and clone it locally.
2.  **Branching**: Create a new branch for your feature or fix (`feat/my-feature` or `fix/my-bug`).
3.  **Strict Linting**: We enforce strict TypeScript and ESLint rules. Run `pnpm lint` before committing.
4.  **Commit Messages**: We use [Conventional Commits](https://www.conventionalcommits.org/).
    - `feat: add new command`
    - `fix: resolve crash on startup`
    - `chore: update dependencies`
5.  **Pull Request**: Submit a PR to `main` with a clear description.

## Code Standards

- **TypeScript**: No `any`. Use strict mode.
- **Formatting**: Prettier is enforced via Git hooks.
- **Testing**: Add tests for new features (`pnpm test`).

## Monorepo Commands

- `pnpm install`: Install dependencies.
- `pnpm build`: Build all apps.
- `pnpm dev`: Start all apps in watch mode.
