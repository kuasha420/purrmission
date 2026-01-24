
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkGuardians() {
    const envId = '1e4b4a9d-ba02-40ba-9506-0bfb255dd73a';
    console.log(`Looking up environment: ${envId}`);

    const env = await prisma.environment.findUnique({
        where: { id: envId }
    });

    if (!env) {
        console.error('Environment not found!');
        return;
    }

    console.log(`Found Environment: ${env.name}, Resource ID: ${env.resourceId}`);

    const resource = await prisma.resource.findUnique({
        where: { id: env.resourceId },
        include: { guardians: true }
    });

    if (!resource) {
        console.error('Resource not found!');
        return;
    }

    console.log('Resource:', resource.name);
    console.log('Guardians:', resource.guardians);
}

checkGuardians()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
