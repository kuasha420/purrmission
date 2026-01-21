import { PrismaClient } from '@prisma/client';
import { encryptValue } from '../apps/purrmission-bot/src/infra/crypto.js';

const prisma = new PrismaClient();

if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY environment variable is not set. Please provide a 32-byte hex-encoded key.');
}

async function main() {
    const userId = '342649576785838080';
    console.log(`Seeding data for User ID: ${userId}`);

    // 1. Create Project
    const project = await prisma.project.create({
        data: {
            name: 'Pawthy Verification Project',
            description: 'Project for verifying CLI',
            ownerId: userId,
            environments: {
                create: {
                    name: 'Development',
                    slug: 'dev',
                    resource: {
                        create: {
                            name: 'Test Database Credentials',
                            mode: 'ONE_OF_N',
                            apiKey: 'test-api-key',
                            guardians: {
                                create: {
                                    discordUserId: userId,
                                    role: 'OWNER'
                                }
                            },
                            fields: {
                                create: [
                                    { name: 'DB_HOST', value: encryptValue('localhost') },
                                    { name: 'DB_USER', value: encryptValue('admin') },
                                    { name: 'DB_PASS', value: encryptValue('super_secret_password') }
                                ]
                            }
                        }
                    }
                }
            }
        },
        include: {
            environments: {
                include: {
                    resource: true
                }
            }
        }
    });

    console.log('✅ Created Project:', project.name);
    console.log('✅ Created Environment: Development');
    console.log('✅ Created Resource linked to Environment');
    console.log('✅ Added Guardian:', userId);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
