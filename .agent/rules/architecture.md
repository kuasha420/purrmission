---
trigger: always_on
---

# Architecture Details

## TOTP System

### TOTP Engine (`apps/purrmission-bot/src/domain/totp.ts`)
Core TOTP functionality using `otplib`:
- Parse OTPauth URIs
- Create TOTP accounts from URIs or secrets
- Automatic secret sanitization (whitespace removal)
- Generate 6-digit TOTP codes
- Validate TOTP codes (optional)

### TOTP Repository
Configuration in `apps/purrmission-bot/src/domain/repositories.ts`:
- `PrismaTOTPRepository`: default implementation
- Stores accounts in SQLite via Prisma ORM
- Supports personal and shared accounts
- CRUD operations: create, read, list, delete

## Approval Workflow

### Approval Request System
- **Resource**: Gated resource requiring approval
- **Guardian**: User who can approve/deny requests
- **ApprovalRequest**: Request with status tracking
- **Mode**: `REQUIRE_ALL` or `REQUIRE_ANY`

### Repository Pattern
- `ApprovalRepository`: Interface for approval data
- `ResourceRepository`: Interface for resource data
- `GuardianRepository`: Interface for guardian data
- Prisma implementations (`Prisma*Repository`) provided in `src/domain/repositories.ts`

## Discord Integration

### Command Structure
- Location: `apps/purrmission-bot/src/commands/`
- Uses `discord.js` SlashCommandBuilder
- Commands implement `Command` interface
- Router: `handlePurrmissionCommand` in command files

### Command Flow
1. User invokes slash command
2. Bot validates permissions
3. Command handler processes request
4. Repository layer persists changes to SQLite via Prisma
5. Bot responds with formatted message

## HTTP API Structure

### Server (`apps/purrmission-bot/src/api/server.ts`)
- Fastify server (optional, triggered by `PORT` env var)
- RESTful endpoints for TOTP and approval operations
- Zod validation for request bodies
- Error handling middleware

### API Routes
- `/api/totp` - TOTP operations
- `/api/approvals` - Approval request operations
- `/api/resources` - Resource management
- Health check endpoints

## Data Models

### Domain Models (`apps/purrmission-bot/src/domain/models.ts`)
- **TOTPAccount**: TOTP configuration and metadata
- **Resource**: Gated resource definition
- **Guardian**: Approval authority
- **ApprovalRequest**: Request with status and votes

### Schema Definition
- Primary source of truth for data models is `prisma/schema.prisma`.
- TypeScript interfaces match the database schema.

### Type Safety
- Strict TypeScript mode enabled
- Zod schemas for runtime validation
- Explicit type annotations required
- No `any` types without justification

## Error Handling

### Custom Error Classes
- Domain-specific errors for business logic
- HTTP-specific errors for API responses
- Type guards for error narrowing

### Logging
- Minimal logger utility
- Console-based for development
- Structured output for production