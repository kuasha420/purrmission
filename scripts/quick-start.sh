#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Purrmission Quick Start ===${NC}"

# 1. Check Prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is not installed.${NC}"
    exit 1
fi
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}PNPM is not installed.${NC}"
    exit 1
fi
echo -e "${GREEN}Prerequisites OK.${NC}"

# 2. Environment Setup
echo -e "${YELLOW}Setting up environment...${NC}"
if [ ! -f .env ]; then
    echo -e "Creating .env from .env.example..."
    cp .env.example .env
    echo -e "${YELLOW}PLEASE UPDATE .env WITH YOUR CREDENTIALS NOW.${NC}"
    # Optional: interactively ask for tokens if we want to be fancy
else
    echo -e "${GREEN}.env exists.${NC}"
fi

# 3. Install Dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
pnpm install

# 4. Database Setup
echo -e "${YELLOW}Setting up database...${NC}"
pnpm prisma:generate
# Check if we can run migrate (needs DB url)
if grep -q -E '^DATABASE_URL=.+' .env; then
    pnpm prisma:deploy || echo -e "${YELLOW}Migration deploy failed. Skipping.${NC}"
else 
    echo -e "${YELLOW}No DATABASE_URL in .env. Skipping migration.${NC}"
fi

# 5. MCP Sync
echo -e "${YELLOW}Syncing MCP config...${NC}"
pnpm mcp:sync

echo -e "${GREEN}=== Setup Complete ===${NC}"
echo -e "Run ${BLUE}pnpm dev${NC} to start the development server."
