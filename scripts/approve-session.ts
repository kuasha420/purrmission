import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: tsx scripts/approve-session.ts <userCode> <discordUserId>');
        process.exit(1);
    }

    const userCode = args[0].toUpperCase();
    const discordUserId = args[1];

    console.log(`Approving session for code: ${userCode} for user: ${discordUserId}`);

    try {
        const session = await prisma.authSession.findFirst({
            where: { userCode }
        });

        if (!session) {
            console.error('Session not found!');
            process.exit(1);
        }

        if (session.status !== 'PENDING') {
            console.warn(`Session status is ${session.status}, continuing anyway...`);
        }

        const updated = await prisma.authSession.update({
            where: { id: session.id },
            data: {
                status: 'APPROVED',
                userId: discordUserId
            }
        });

        console.log(`✅ Session approved! ID: ${updated.id}`);
    } catch (e) {
        console.error('Error approving session:', e);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

main();
