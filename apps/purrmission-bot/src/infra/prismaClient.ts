import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;

/**
 * Returns a shared PrismaClient instance for the purrmission-bot app.
 *
 * This ensures we don't create multiple clients in dev/hot-reload scenarios.
 */
export function getPrismaClient(): PrismaClient {
    if (!prisma) {
        prisma = new PrismaClient();
    }

    return prisma;
}
