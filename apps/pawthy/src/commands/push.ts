import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { getToken, getApiUrl, getProjectConfig } from '../config.js';

export const pushCommand = new Command('push')
    .description('Push local .env secrets to Purrmission, updating existing values. This does not remove secrets.')
    .option('-f, --file <path>', 'Path to .env file', '.env')
    .option('--force', 'Push secrets without confirmation')
    .option('-p, --project-id <id>', 'Project ID')
    .option('-e, --env-id <id>', 'Environment ID')
    .action(async (options) => {
        const token = getToken();
        const apiUrl = getApiUrl();
        const config = await getProjectConfig();

        if (!token) {
            console.error(chalk.red('You must be logged in. Run `pawthy login` first.'));
            process.exit(1);
        }

        const projectId = options.projectId || process.env.PAWTHY_PROJECT_ID || config?.projectId;
        const envId = options.envId || process.env.PAWTHY_ENV_ID || config?.envId;

        if (!projectId || !envId) {
            console.error(
                chalk.red(
                    'Project ID and Environment ID must be specified (via CLI flags -p/-e, env vars PAWTHY_PROJECT_ID/PAWTHY_ENV_ID, or .pawthyrc config).'
                )
            );
            process.exit(1);
        }

        const envPath = path.resolve(process.cwd(), options.file);

        try {
            // 1. Read and Parse .env
            const envContent = await fs.readFile(envPath, 'utf-8');
            const secrets = dotenv.parse(envContent);

            if (Object.keys(secrets).length === 0) {
                console.log(chalk.yellow('No secrets found in the specified file.'));
                return;
            }

            // 2. Confirmation Prompt
            if (!options.force) {
                const inquirer = (await import('inquirer')).default;
                const { confirm } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'confirm',
                    message: `You are about to push ${Object.keys(secrets).length} secrets to Purrmission. This may overwrite existing values. Continue?`,
                    default: false,
                }]);

                if (!confirm) {
                    console.log(chalk.yellow('Push cancelled.'));
                    return;
                }
            }

            console.log(chalk.dim(`Pushing ${Object.keys(secrets).length} secrets to Purrmission...`));

            // 3. Push to API
            await axios.put(`${apiUrl}/api/projects/${projectId}/environments/${envId}/secrets`, {
                secrets
            }, {
                headers: { Authorization: `Bearer ${token}` },
            });

            console.log(chalk.green('\n✅ Secrets pushed successfully!'));

        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.response?.status === 401) {
                    console.error(chalk.red('Session expired. Please run `pawthy login` again.'));
                } else if (error.response?.status === 403) {
                    console.error(chalk.red('Access denied. You do not have permission to push secrets to this environment.'));
                } else if (error.response?.status === 404) {
                    console.error(chalk.red('Project or Environment not found. It may have been deleted.'));
                } else {
                    console.error(chalk.red(`Failed to push secrets: ${error.message}`));
                }
            } else if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') {
                console.error(chalk.red(`File not found: ${envPath}`));
            } else {
                console.error(chalk.red(`An error occurred: ${error instanceof Error ? error.message : String(error)}`));
            }
            process.exit(1);
        }
    });
