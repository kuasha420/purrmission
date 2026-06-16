import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { getToken, getApiUrl, getProjectConfig } from '../config.js';

export const pullCommand = new Command('pull')
    .description('Pull secrets from Purrmission to local .env')
    .option('-f, --file <path>', 'Path to .env file', '.env')
    .option('-p, --project-id <id>', 'Project ID')
    .option('-e, --env-id <id>', 'Environment ID')
    .option('-m, --merge', 'Merge with existing .env file instead of overwriting')
    .action(async (options) => {
        const token = getToken();
        const apiUrl = getApiUrl();
        if (!token) {
            console.error(chalk.red('You must be logged in. Run `pawthy login` first.'));
            process.exit(1);
            return;
        }

        let projectId = options.projectId;
        let envId = options.envId;

        if (!projectId || !envId) {
            const config = await getProjectConfig();
            projectId = projectId || config?.projectId || process.env.PAWTHY_PROJECT_ID;
            envId = envId || config?.envId || process.env.PAWTHY_ENV_ID;
        }

        if (!projectId || !envId) {
            console.error(
                chalk.red(
                    'Project ID and Environment ID must be specified (via CLI flags -p/-e, env vars PAWTHY_PROJECT_ID/PAWTHY_ENV_ID, or .pawthyrc config).'
                )
            );
            process.exit(1);
            return;
        }

        const envPath = path.resolve(process.cwd(), options.file);

        try {
            console.log(chalk.dim('Fetching secrets from Purrmission...'));

            // 1. Fetch Secrets
            const res = await axios.get<{ secrets?: Record<string, string>; status?: string; message?: string }>(
                `${apiUrl}/api/projects/${projectId}/environments/${envId}/secrets`,
                {
                    headers: { Authorization: `Bearer ${token}` },
                    validateStatus: (status) => status >= 200 && status < 300,
                }
            );

            if (res.status === 202) {
                console.log(`\n${chalk.yellow('⏳ Access Pending Approval')}`);
                console.log(chalk.white(res.data.message));
                console.log(chalk.dim('\nPlease run this command again once your request has been approved in Discord.'));
                process.exit(1);
                return;
            }

            const secrets = res.data.secrets;

            if (!secrets || Object.keys(secrets).length === 0) {
                console.log(chalk.yellow('No secrets found for this environment.'));
                return;
            }

            let content = '';
            let isMerged = false;

            if (options.merge) {
                try {
                    const existingContent = await fs.readFile(envPath, 'utf-8');
                    content = mergeEnvSecrets(existingContent, secrets);
                    isMerged = true;
                } catch (e: any) {
                    if (e.code !== 'ENOENT') {
                        throw e;
                    }
                    // File doesn't exist, fallback to regular pull behavior
                }
            }

            if (!isMerged) {
                // 2. Format as .env
                content = Object.entries(secrets)
                    .map(([key, value]) => {
                        // Wrap values with spaces or special chars in quotes
                        if (value.includes(' ') || value.includes('#') || value.includes('=')) {
                            return `${key}="${value.replace(/"/g, '\\"')}"`;
                        }
                        return `${key}=${value}`;
                    })
                    .join('\n') + '\n';

                // 3. Write to file with safety check
                try {
                    await fs.access(envPath);
                    console.warn(chalk.yellow(`\n⚠️  File ${options.file} already exists.`));
                    console.warn(chalk.yellow('Overwriting existing file...'));
                } catch {
                    // File doesn't exist, proceed safe.
                }
            }

            // 3. Write to file
            await fs.writeFile(envPath, content);

            console.log(chalk.green(`\n✅ Successfully pulled ${Object.keys(secrets).length} secrets to ${options.file}`));

        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.response?.status === 401) {
                    console.error(chalk.red('Session expired. Please run `pawthy login` again.'));
                } else if (error.response?.status === 403) {
                    console.error(chalk.red('Access denied. You do not have permission to view secrets in this environment.'));
                } else if (error.response?.status === 404) {
                    console.error(chalk.red('Project or Environment not found. It may have been deleted.'));
                } else {
                    console.error(chalk.red(`Failed to pull secrets: ${error.message}`));
                }
            } else {
                console.error(chalk.red(`An error occurred: ${error instanceof Error ? error.message : String(error)}`));
            }
            process.exit(1);
        }
    });

function mergeEnvSecrets(existingContent: string, secrets: Record<string, string>): string {
    const lines = existingContent.split(/\r?\n/);
    const updatedKeys = new Set<string>();
    const resultLines: string[] = [];

    for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (match) {
            const key = match[1];
            if (key in secrets) {
                const value = secrets[key];
                let formattedValue = value;
                if (value.includes(' ') || value.includes('#') || value.includes('=')) {
                    formattedValue = `"${value.replace(/"/g, '\\"')}"`;
                }
                const leadingWhitespace = line.match(/^\s*/)?.[0] || '';
                resultLines.push(`${leadingWhitespace}${key}=${formattedValue}`);
                updatedKeys.add(key);
                continue;
            }
        }
        resultLines.push(line);
    }

    const newKeys = Object.keys(secrets).filter((k) => !updatedKeys.has(k));
    if (newKeys.length > 0) {
        if (resultLines.length > 0 && resultLines[resultLines.length - 1].trim() !== '') {
            resultLines.push('');
        }
        for (const key of newKeys) {
            const value = secrets[key];
            let formattedValue = value;
            if (value.includes(' ') || value.includes('#') || value.includes('=')) {
                formattedValue = `"${value.replace(/"/g, '\\"')}"`;
            }
            resultLines.push(`${key}=${formattedValue}`);
        }
    }

    return resultLines.join('\n');
}
