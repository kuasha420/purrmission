import Conf from 'conf';

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
