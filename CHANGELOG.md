# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2025-12-10

### Added
- Initial Purrmission 2FA MVP for Discord (`@purrfecthq/purrmission-bot`).
- `/purrmission 2fa` command group:
  - `add`: Store TOTP secrets via URI or Base32 secret.
  - `list`: View personal and shared accounts.
  - `get`: Retrieve TOTP codes via DM with autocomplete.
  - `update`: Add backup keys to accounts (owner only).
- In-memory domain repository layer (replaceable with Prisma).
- SQLite Database via Prisma ORM (`prisma/purrmission.db`).
- Basic HTTP API structure for future approval requests.
