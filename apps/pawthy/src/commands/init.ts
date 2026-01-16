import { Command } from 'commander';
import inquirer from 'inquirer';
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { getToken, getApiUrl } from '../config.js';

interface Project {
    id: string;
    name: string;
}

interface Environment {
    id: string;
    name: string;
    slug: string;
}

export const initCommand = new Command('init')
    .description('Initialize a new project in the current directory')
    .action(async () => {
        const token = getToken();
        const apiUrl = getApiUrl();

        if (!token) {
            console.error(chalk.red('You must be logged in to initialize a project. Run `pawthy login` first.'));
            process.exit(1);
        }

        try {
            console.log(chalk.dim('Fetching projects...'));

            // 1. Fetch Projects
            const projectsRes = await axios.get<Project[]>(`${apiUrl}/api/projects`, {
                headers: { Authorization: `Bearer ${token}` },
            });

            const projects = projectsRes.data;

            if (projects.length === 0) {
                console.error(chalk.yellow('No projects found. Please create a project via the API or Web UI first.'));
                process.exit(1);
            }

            // 2. Select Project
            const { projectId } = await inquirer.prompt([{
                type: 'list',
                name: 'projectId',
                message: 'Select a project:',
                choices: projects.map(p => ({
                    name: p.name,
                    value: p.id
                }))
            }]);

            // 3. Fetch Environments
            const envsRes = await axios.get<Environment[]>(`${apiUrl}/api/projects/${projectId}/environments`, {
                headers: { Authorization: `Bearer ${token}` },
            });

            const envs = envsRes.data;
            if (envs.length === 0) {
                console.error(chalk.yellow('No environments found for this project.'));
                process.exit(1);
            }

            // 4. Select Environment
            const { envId } = await inquirer.prompt([{
                type: 'list',
                name: 'envId',
                message: 'Select an environment:',
                choices: envs.map(e => ({
                    name: `${e.name} (${e.slug})`,
                    value: e.id
                }))
            }]);

            // 5. Write .pawthyrc
            const config = {
                projectId,
                envId
            };

            await fs.writeFile(path.join(process.cwd(), '.pawthyrc'), JSON.stringify(config, null, 2));
            console.log(chalk.green('\n✅ Project initialized! Configuration saved to .pawthyrc'));

        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.response?.status === 401) {
                    console.error(chalk.red('Session expired. Please run `pawthy login` again.'));
                } else {
                    console.error(chalk.red(`Failed to fetch data: ${error.message}`));
                }
            } else {
                console.error(chalk.red(`An error occurred: ${error instanceof Error ? error.message : String(error)}`));
            }
            process.exit(1);
        }
    });
