FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# 1. Prune the workspace for the app
FROM base AS pruner
WORKDIR /app
RUN pnpm add -g turbo
COPY . .
RUN turbo prune --scope=@purrfecthq/modmail-bot --docker

# 2. Install dependencies & Build
FROM base AS builder
WORKDIR /app

# Copy lockfile and package.json's of isolated subworkspace
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml

RUN pnpm install --frozen-lockfile

# Copy source code of isolated subworkspace
COPY --from=pruner /app/out/full/ .

RUN pnpm turbo run build --filter=@purrfecthq/modmail-bot...

# 3. Production image
FROM base AS runner
WORKDIR /app

# Deploy the app to a prod folder with all deps
RUN pnpm deploy --filter=@purrfecthq/modmail-bot --prod /prod/modmail-bot

FROM base AS production
WORKDIR /app
COPY --from=builder /prod/modmail-bot .

CMD ["node", "dist/index.js"]
