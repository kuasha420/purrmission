import Conf from 'conf';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

interface PawthyConfig {
    token?: string;
    projectId?: string;
    envId?: string;
    apiUrl?: string;
}

interface LocalConfig {
    token?: string;
}

export type ConfigScope = 'local' | 'global';

const config = new Conf<PawthyConfig>({
    projectName: 'pawthy',
    defaults: {
        apiUrl: 'https://purrmission.infra.purrfecthq.com', // Default to production for release
    },
});

const LOCAL_CONFIG_DIR = '.pawthy';
const LOCAL_CONFIG_FILE = 'config.json';

/**
 * Get the path to the local config directory (.pawthy/)
 */
function getLocalConfigDir(): string {
    return path.join(process.cwd(), LOCAL_CONFIG_DIR);
}

/**
 * Get the path to the local config file (.pawthy/config.json)
 */
function getLocalConfigPath(): string {
    return path.join(getLocalConfigDir(), LOCAL_CONFIG_FILE);
}

/**
 * Read local config from .pawthy/config.json if it exists
 */
function readLocalConfig(): LocalConfig | null {
    const configPath = getLocalConfigPath();
    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

/**
 * Write local config to .pawthy/config.json
 */
function writeLocalConfig(localConfig: LocalConfig): void {
    const configDir = getLocalConfigDir();
    const configPath = getLocalConfigPath();

    // Ensure .pawthy directory exists
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(configPath, JSON.stringify(localConfig, null, 2), 'utf-8');
}

/**
 * Get token from local config if it exists
 */
function getLocalToken(): string | undefined {
    const localConfig = readLocalConfig();
    return localConfig?.token;
}

/**
 * Set token in local config
 */
function setLocalToken(token: string): void {
    const localConfig = readLocalConfig() || {};
    localConfig.token = token;
    writeLocalConfig(localConfig);
}

/**
 * Ensure .pawthy/ is in .gitignore (or warn if no gitignore exists)
 */
export function ensureGitignore(): void {
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    const pawthyEntry = LOCAL_CONFIG_DIR + '/';

    try {
        if (fs.existsSync(gitignorePath)) {
            const content = fs.readFileSync(gitignorePath, 'utf-8');
            // Check if .pawthy/ is already in .gitignore (exact line match)
            const lines = content.split('\n').map(line => line.trim());
            if (!lines.includes(pawthyEntry) && !lines.includes(LOCAL_CONFIG_DIR)) {
                // Append .pawthy/ to .gitignore
                const newContent = content.endsWith('\n')
                    ? content + pawthyEntry + '\n'
                    : content + '\n' + pawthyEntry + '\n';
                fs.writeFileSync(gitignorePath, newContent, 'utf-8');
                console.log(chalk.dim(`Added '${pawthyEntry}' to .gitignore`));
            }
        } else {
            // No .gitignore exists, warn the user
            console.log(chalk.yellow(`Warning: No .gitignore found. Consider adding '${pawthyEntry}' to your .gitignore`));
        }
    } catch (error) {
        console.log(chalk.yellow(`Warning: Could not update .gitignore: ${(error as Error).message}`));
    }
}

/**
 * Get token with Local > Global priority
 */
export function getToken(): string | undefined {
    // Priority: Local > Global
    const localToken = getLocalToken();
    if (localToken) {
        return localToken;
    }
    return config.get('token');
}

/**
 * Set token in the specified scope (default: global)
 */
export function setToken(token: string, scope: ConfigScope = 'global'): void {
    if (scope === 'local') {
        setLocalToken(token);
        ensureGitignore();
        return;
    }
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
