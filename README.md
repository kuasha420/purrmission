# Purrmission

> **Reliable Approval Gates & ModMail for Modern Discord Communities**

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)
![Docker](https://img.shields.io/badge/Docker-Ready-blue)

## Monorepo Structure

This project is a monorepo managed by [TurboRepo](https://turbo.build/) and [PNPM](https://pnpm.io/).

- **`apps/purrmission-bot`**: The core approval gate bot and API.
- **`apps/modmail-bot`**: A modern, stateless ModMail bot.

## Getting Started

### Prerequisites

- Node.js v24+
- PNPM v9+
- Docker (optional)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/purrfecthq/purrmission.git
   cd purrmission
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Configure Environment**:
   Copy `.env.example` to `.env` and fill in your tokens.

4. **Build**:
   ```bash
   pnpm build
   ```

5. **Run Development Mode**:
   ```bash
   pnpm dev
   ```

## Docker Deployment

We provide a `docker-compose.yml` for easy orchestration.

```bash
docker compose up -d --build
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
