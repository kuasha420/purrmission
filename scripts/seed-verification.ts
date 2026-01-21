import { PrismaClient } from '@prisma/client';
import { randomBytes, createCipheriv } from 'crypto';

const prisma = new PrismaClient();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '5079736da56b5626c6930f64372f22b65afd452a1d6594d86c1e220db6431119';

function encrypt(text: string) {
    const iv = randomBytes(12); // GCM standard IV length
    const keyBuffer = Buffer.from(ENCRYPTION_KEY, 'hex');
    const cipher = createCipheriv('aes-256-gcm', keyBuffer, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Format matching apps/purrmission-bot/src/infra/crypto.ts
    // v1:base64(iv):base64(authTag):base64(ciphertext)
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
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
                                    { name: 'DB_HOST', value: encrypt('localhost') },
                                    { name: 'DB_USER', value: encrypt('admin') },
                                    { name: 'DB_PASS', value: encrypt('super_secret_password') }
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
