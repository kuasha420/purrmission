import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const args = process.argv.slice(2);
    // Optional: pass requestId. If not, approve the latest PENDING.
    const requestId = args[0];

    try {
        let request;
        if (requestId) {
            request = await prisma.approvalRequest.findUnique({ where: { id: requestId } });
        } else {
            request = await prisma.approvalRequest.findFirst({
                where: { status: 'PENDING' },
                orderBy: { createdAt: 'desc' }
            });
        }

        if (!request) {
            console.error('No pending approval request found!');
            process.exit(1);
        }

        console.log(`Approving request ID: ${request.id} for Resource: ${request.resourceId}`);

        // Update to APPROVED
        await prisma.approvalRequest.update({
            where: { id: request.id },
            data: {
                status: 'APPROVED',
                resolvedBy: '1234567890', // Test User
                resolvedAt: new Date()
            }
        });

        console.log('✅ Request approved!');

    } catch (e) {
        console.error('Error approving request:', e);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

main();
