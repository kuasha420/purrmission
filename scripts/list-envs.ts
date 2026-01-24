
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function listEnvironments() {
    const envs = await prisma.environment.findMany();
    console.log('Environments:', envs);
}

listEnvironments()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
