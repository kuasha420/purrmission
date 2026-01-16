import Conf from 'conf';
import fs from 'fs';
import path from 'path';

interface PawthyConfig {
    token?: string;
    projectId?: string;
    envId?: string;
    apiUrl?: string;
}

const config = new Conf<PawthyConfig>({
    projectName: 'pawthy',
    defaults: {
        apiUrl: 'http://localhost:3000', // Default to local for now, can be changed via env or init
    },
});

export function getToken(): string | undefined {
    return config.get('token');
}

export function setToken(token: string): void {
    config.set('token', token);
}

export function getApiUrl(): string {
    return process.env.PAWTHY_API_URL || config.get('apiUrl') || 'http://localhost:3000';
}

export function setApiUrl(url: string): void {
    config.set('apiUrl', url);
}

export function clearConfig(): void {
    config.clear();
}

export async function getProjectConfig(): Promise<{ projectId: string; envId: string } | null> {
    const configPath = path.join(process.cwd(), '.pawthyrc');
    try {
        const content = await fs.promises.readFile(configPath, 'utf-8');
        return JSON.parse(content);
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            return null;
        }
        if (e instanceof SyntaxError) {
            console.error(`Error: Could not parse project configuration file at ${configPath}. It appears to be malformed.`);
        } else {
            console.error(`Error: Failed to read project configuration from ${configPath}:`, e.message);
        }
        process.exit(1);
    }
}
