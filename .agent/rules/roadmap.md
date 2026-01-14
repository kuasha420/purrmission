---
trigger: always_on
---

# Project Roadmap

## Current Phase: Operational Readiness & Persistence

**Focus**: Reliable data storage (Prisma), Security hardening, and Deployment automation.

### Completed
- ✅ Initial Discord bot structure
- ✅ TOTP engine core logic and encryption
- ✅ Data persistence with Prisma (SQLite)
- ✅ Audit logging implementation
- ✅ Rate limiting
- ✅ Testing framework setup (node:test)
- ✅ Deployment automation scripts

## Immediate Priorities
**Goal**: Finalize core feature set for release

- [ ] Complete HTTP API implementation
- [ ] Implement remaining guardian management commands
- [ ] Add approval request lifecycle tests
- [ ] Enhance documentation for external API consumers

## Feature Completion
**Goal**: Implement core functionality

- [ ] Complete HTTP API implementation
- [x] Add persistent storage (SQLite via Prisma)
- [ ] Implement approval workflow commands (In Progress)
- [ ] Add guardian management commands
- [ ] Implement resource management
- [ ] Add approval request lifecycle

## Security Enhancements
**Goal**: Ensure production-ready security

- [x] Audit TOTP implementation (Sanitization added)
- [x] Add rate limiting on API endpoints (and Discord commands)
- [ ] Implement proper authentication for HTTP API
- [x] Secure secret storage (AES-256-GCM)
- [x] Add audit logging

## Code Quality
**Goal**: Maintain high code quality

- [ ] Add JSDoc comments for exported functions
- [ ] Review and refactor large functions
- [ ] Standardize error handling
- [ ] Add pre-commit hooks (lint, format, test)
- [ ] Set up ESLint and Prettier (Configured)

## Documentation
**Goal**: Improve developer experience

- [ ] Complete README with all commands
- [ ] Add API documentation
- [ ] Create deployment guide (DEPLOY.md exists)
- [ ] Add troubleshooting section
- [ ] Document environment variables

## Development Process
**Strategy**: Atomic commits, verify after each change

1. Fix one thing at a time
2. Run tests after every fix
3. Update documentation
4. Create PR with clear description
5. Address review feedback promptly

## Next Steps
1. Implement HTTP API endpoints
2. Finalize approval workflow commands
3. Add deployment automation (CI/CD)