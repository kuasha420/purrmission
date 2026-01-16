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

export function getProjectConfig(): { projectId: string; envId: string } | null {
    try {
        const configPath = path.join(process.cwd(), '.pawthyrc');
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
    } catch (e: any) {
        // If the config file does not exist, treat it as "no project config" and return null.
        if (e && e.code === 'ENOENT') {
            return null;
        }
        // For other errors (e.g., permission issues, corrupted file), log the error for visibility.
        console.error('Failed to read project configuration from .pawthyrc:', e);
        return null;
    }
}
