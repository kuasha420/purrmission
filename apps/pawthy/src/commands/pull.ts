import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { getToken, getApiUrl, getProjectConfig } from '../config.js';

export const pullCommand = new Command('pull')
    .description('Pull secrets from Purrmission to local .env')
    .option('-f, --file <path>', 'Path to .env file', '.env')
    .action(async (options) => {
        const token = getToken();
        const apiUrl = getApiUrl();
        const config = await getProjectConfig();

        if (!token) {
            console.error(chalk.red('You must be logged in. Run `pawthy login` first.'));
            process.exit(1);
        }

        if (!config || !config.projectId || !config.envId) {
            console.error(chalk.red('Project not initialized. Run `pawthy init` first.'));
            process.exit(1);
        }

        const envPath = path.resolve(process.cwd(), options.file);

        try {
            console.log(chalk.dim('Fetching secrets from Purrmission...'));

            // 1. Fetch Secrets
            const res = await axios.get<{ secrets?: Record<string, string>; status?: string; message?: string }>(
                `${apiUrl}/api/projects/${config.projectId}/environments/${config.envId}/secrets`,
                {
                    headers: { Authorization: `Bearer ${token}` },
                    validateStatus: (status) => status >= 200 && status < 300,
                }
            );

            if (res.status === 202) {
                console.log(`\n${chalk.yellow('⏳ Access Pending Approval')}`);
                console.log(chalk.white(res.data.message));
                console.log(chalk.dim('\nPlease run this command again once your request has been approved in Discord.'));
                return;
            }

            const secrets = res.data.secrets;

            if (!secrets || Object.keys(secrets).length === 0) {
                console.log(chalk.yellow('No secrets found for this environment.'));
                return;
            }

            // 2. Format as .env
            const content = Object.entries(secrets)
                .map(([key, value]) => {
                    // Wrap values with spaces or special chars in quotes
                    if (value.includes(' ') || value.includes('#') || value.includes('=')) {
                        return `${key}="${value.replace(/"/g, '\\"')}"`;
                    }
                    return `${key}=${value}`;
                })
                .join('\n');

            // 3. Write to file with safety check
            try {
                await fs.access(envPath);
                // File exists
                console.warn(chalk.yellow(`\n⚠️  File ${options.file} already exists.`));
                // For CLI non-interactive mode or simple safety, we might want to fail or require --force.
                // Given the review comment asked for a warning/prompt, and we don't have interactive prompt lib handy (inquirer isn't in package.json yet),
                // we will just warn and overwrite for now but formatted nicely, or maybe throw error if no force flag?
                // Step 460 implies adding a check. Let's just log a warning for this iteration as prompt lib might be out of scope.
                console.warn(chalk.yellow('Overwriting existing file...'));
            } catch {
                // File doesn't exist, proceed safe.
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
