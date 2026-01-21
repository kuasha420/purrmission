import { PrismaClient } from '@prisma/client';
import { encryptWithKey } from '../apps/purrmission-bot/src/infra/crypto.js';

const prisma = new PrismaClient();

const encryptionKeyHex = process.env.ENCRYPTION_KEY;
if (!encryptionKeyHex) {
    throw new Error('ENCRYPTION_KEY environment variable is not set. Please provide a 32-byte hex-encoded key.');
}
const encryptionKey = Buffer.from(encryptionKeyHex, 'hex');

async function main() {
    const userId = process.env.SEED_USER_ID || '342649576785838080';
    const apiKey = process.env.SEED_API_KEY || 'test-api-key';

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
                            apiKey: apiKey,
                            guardians: {
                                create: {
                                    discordUserId: userId,
                                    role: 'OWNER'
                                }
                            },
                            fields: {
                                create: [
                                    { name: 'DB_HOST', value: encryptWithKey('localhost', encryptionKey) },
                                    { name: 'DB_USER', value: encryptWithKey('admin', encryptionKey) },
                                    { name: 'DB_PASS', value: encryptWithKey('P@wthY-S3cr3t-V3r1fy-Pa$$', encryptionKey) }
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
