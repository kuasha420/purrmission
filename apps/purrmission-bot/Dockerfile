FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# 1. Prune the workspace for the app
FROM base AS pruner
WORKDIR /app
RUN pnpm add -g turbo
COPY . .
RUN turbo prune --scope=@purrfecthq/purrmission-bot --docker

# 2. Install dependencies & Build
FROM base AS builder
WORKDIR /app

# Copy lockfile and package.json's of isolated subworkspace
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml

RUN pnpm install --frozen-lockfile

# Copy source code of isolated subworkspace
COPY --from=pruner /app/out/full/ .

RUN pnpm turbo run build --filter=@purrfecthq/purrmission-bot...

# 3. Production image
FROM base AS runner
WORKDIR /app

COPY --from=builder /app/apps/purrmission-bot/package.json .
COPY --from=builder /app/apps/purrmission-bot/dist ./dist

# We need production dependencies.
# Since we don't have a bundle, we need node_modules.
# We can use `pnpm deploy` in builder to get a ready-to-run folder.

# Let's adjust builder to use pnpm deploy
RUN pnpm deploy --filter=@purrfecthq/purrmission-bot --prod /prod/purrmission-bot

FROM base AS production
WORKDIR /app
COPY --from=builder /prod/purrmission-bot .

CMD ["node", "dist/index.js"]
