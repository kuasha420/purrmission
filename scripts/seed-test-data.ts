import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'path';

// Load env vars from purrmission-bot to get valid ENCRYPTION_KEY
dotenv.config({ path: path.join(process.cwd(), 'apps/purrmission-bot/.env') });

const prisma = new PrismaClient();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const V1_PREFIX = 'v1:';

function getEncryptionKey(): Buffer {
    const keyHex = process.env.ENCRYPTION_KEY;
    if (!keyHex) throw new Error('ENCRYPTION_KEY not set');
    return Buffer.from(keyHex, 'hex');
}

function encryptValue(plaintext: string): string {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
    });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${V1_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

async function main() {
    const encryptionKey = process.env.ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000'; // Fallback for dev if needed
    if (!process.env.ENCRYPTION_KEY) {
        console.warn('Warning: ENCRYPTION_KEY not found in env, using dummy key.');
        process.env.ENCRYPTION_KEY = encryptionKey;
    }

    console.log('Seeding test data...');

    // 1. Create Resource
    const resource = await prisma.resource.create({
        data: {
            name: 'Production DB',
            apiKey: 'prod-db-key-123',
            mode: 'ONE_OF_N'
        }
    });
    console.log('Created Resource:', resource.id);

    // 2. Create Guardian (Owner)
    const guardian = await prisma.guardian.create({
        data: {
            resourceId: resource.id,
            discordUserId: '1234567890', // Test User ID
            role: 'OWNER'
        }
    });

    // 3. Create Project
    const project = await prisma.project.create({
        data: {
            name: 'Test Project',
            ownerId: '1234567890'
        }
    });
    console.log('Created Project:', project.id);

    // 4. Create Environment linked to Resource
    const env = await prisma.environment.create({
        data: {
            name: 'Production',
            slug: 'prod',
            projectId: project.id,
            resourceId: resource.id
        }
    });
    console.log('Created Environment:', env.id);

    // 5. Create Secrets (Fields) - ENCRYPTED
    await prisma.resourceField.create({
        data: {
            resourceId: resource.id,
            name: 'API_URL',
            value: encryptValue('https://api.example.com')
        }
    });
    await prisma.resourceField.create({
        data: {
            resourceId: resource.id,
            name: 'DB_DIALECT',
            value: encryptValue('postgres')
        }
    });
    console.log('Created Secrets (Encrypted)');

    // Output for .pawthyrc
    const rcConfig = {
        apiUrl: 'http://localhost:3001',
        projectId: project.id,
        envId: env.id
    };

    console.log('\n--- .pawthyrc content ---');
    console.log(JSON.stringify(rcConfig, null, 2));
}

// Clean up helper
async function cleanup() {
    await prisma.resourceField.deleteMany({});
    await prisma.environment.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.guardian.deleteMany({});
    await prisma.resource.deleteMany({});
}

cleanup()
    .then(() => main())
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
