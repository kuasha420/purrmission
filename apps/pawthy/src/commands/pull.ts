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
    .option('-k, --keys <list>', 'Comma-separated list of keys to pull')
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
        let config: { projectId?: string; envId?: string; keys?: string[]; syncKeys?: string[] } | null = null;

        if (!projectId || !envId || !options.keys) {
            config = await getProjectConfig();
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

            let secrets = res.data.secrets || {};

            // Whitelisting / selective keys sync (Issue #80)
            const keysWhitelist = getKeysWhitelist(options.keys, config);

            if (keysWhitelist) {
                const ignoredKeys: string[] = [];
                const filteredSecrets: Record<string, string> = {};
                for (const [key, value] of Object.entries(secrets)) {
                    if (keysWhitelist.has(key)) {
                        filteredSecrets[key] = value;
                    } else {
                        ignoredKeys.push(key);
                    }
                }
                secrets = filteredSecrets;
                if (ignoredKeys.length > 0) {
                    console.log(chalk.yellow(`\n⚠️  Ignored remote keys not in whitelist: ${ignoredKeys.join(', ')}`));
                }
            }

            if (Object.keys(secrets).length === 0) {
                console.log(chalk.yellow('No matching secrets found for this environment.'));
                return;
            }

            let content = '';
            let isMerged = false;

            // Whitelisting forces merge behavior to avoid deleting non-whitelisted local variables (Issue #80)
            const shouldMerge = options.merge || keysWhitelist !== null;

            if (shouldMerge) {
                try {
                    const existingContent = await fs.readFile(envPath, 'utf-8');
                    content = mergeEnvSecrets(existingContent, secrets);
                    isMerged = true;
                } catch (e: unknown) {
                    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw e;
                    }
                    // File doesn't exist, fallback to regular pull behavior
                }
            }

            if (!isMerged) {
                // 2. Format as .env
                content = Object.entries(secrets)
                    .map(([key, value]) => `${key}=${formatEnvValue(value)}`)
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

interface EnvBlock {
    type: 'comment' | 'empty' | 'key-value';
    raw: string;
    key?: string;
    value?: string;
    leadingWhitespace?: string;
    middleWhitespace?: string;
    quote?: '"' | "'" | null;
    comment?: string;
}

function parseEnv(content: string, eol: string = '\n'): EnvBlock[] {
    const lines = content.split(/\r?\n/);
    const blocks: EnvBlock[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        
        if (/^\s*#/.test(line) || /^\s*$/.test(line)) {
            blocks.push({
                type: /^\s*#/.test(line) ? 'comment' : 'empty',
                raw: line,
            });
            i++;
            continue;
        }

        const declMatch = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!declMatch) {
            blocks.push({
                type: 'comment',
                raw: line,
            });
            i++;
            continue;
        }

        const leadingWhitespace = declMatch[1];
        const key = declMatch[2];
        const rest = declMatch[3];

        const prefixLength = leadingWhitespace.length + key.length;
        const middleWhitespaceMatch = line.slice(prefixLength).match(/^\s*=\s*/);
        const middleWhitespace = middleWhitespaceMatch ? middleWhitespaceMatch[0] : '=';

        let value = '';
        let quote: '"' | "'" | null = null;
        let trailingComment = '';
        const rawBlockLines = [line];

        if (rest.startsWith('"')) {
            quote = '"';
            const restValue = rest.slice(1);
            let currentLineIndex = i;
            let foundEnd = false;
            let valAcc = '';
            
            while (currentLineIndex < lines.length) {
                const curLine = currentLineIndex === i ? restValue : lines[currentLineIndex];
                let escaped = false;
                let quoteIndex = -1;
                for (let charIdx = 0; charIdx < curLine.length; charIdx++) {
                    const char = curLine[charIdx];
                    if (char === '\\') {
                        escaped = !escaped;
                    } else if (char === '"' && !escaped) {
                        quoteIndex = charIdx;
                        break;
                    } else {
                        escaped = false;
                    }
                }

                if (quoteIndex !== -1) {
                    valAcc += curLine.slice(0, quoteIndex);
                    trailingComment = curLine.slice(quoteIndex + 1);
                    foundEnd = true;
                    break;
                } else {
                    valAcc += curLine + '\n';
                    if (currentLineIndex > i) {
                        rawBlockLines.push(lines[currentLineIndex]);
                    }
                    currentLineIndex++;
                }
            }

            if (foundEnd) {
                value = valAcc;
                i = currentLineIndex + 1;
            } else {
                quote = null;
                value = rest;
                i++;
            }
        } else if (rest.startsWith("'")) {
            quote = "'";
            const restValue = rest.slice(1);
            let currentLineIndex = i;
            let foundEnd = false;
            let valAcc = '';

            while (currentLineIndex < lines.length) {
                const curLine = currentLineIndex === i ? restValue : lines[currentLineIndex];
                let escaped = false;
                let quoteIndex = -1;
                for (let charIdx = 0; charIdx < curLine.length; charIdx++) {
                    const char = curLine[charIdx];
                    if (char === '\\') {
                        escaped = !escaped;
                    } else if (char === "'" && !escaped) {
                        quoteIndex = charIdx;
                        break;
                    } else {
                        escaped = false;
                    }
                }

                if (quoteIndex !== -1) {
                    valAcc += curLine.slice(0, quoteIndex);
                    trailingComment = curLine.slice(quoteIndex + 1);
                    foundEnd = true;
                    break;
                } else {
                    valAcc += curLine + '\n';
                    if (currentLineIndex > i) {
                        rawBlockLines.push(lines[currentLineIndex]);
                    }
                    currentLineIndex++;
                }
            }

            if (foundEnd) {
                value = valAcc;
                i = currentLineIndex + 1;
            } else {
                quote = null;
                value = rest;
                i++;
            }
        } else {
            const commentMatch = rest.match(/(\s+#.*)$/);
            if (commentMatch) {
                value = rest.slice(0, rest.length - commentMatch[1].length).trim();
                trailingComment = commentMatch[1];
            } else {
                value = rest.trim();
                trailingComment = '';
            }
            quote = null;
            i++;
        }

        blocks.push({
            type: 'key-value',
            raw: rawBlockLines.join(eol),
            key,
            value,
            leadingWhitespace,
            middleWhitespace,
            quote,
            comment: trailingComment,
        });
    }
    return blocks;
}

function formatEnvValue(value: string, originalQuote?: '"' | "'" | null): string {
    if (value.includes('\n') || value.includes('\r')) {
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    
    if (/[#=\s'"]/.test(value)) {
        const quote = (originalQuote === '"' || originalQuote === "'") ? originalQuote : '"';
        if (quote === '"') {
            return `"${value.replace(/"/g, '\\"')}"`;
        } else {
            return `'${value.replace(/'/g, "\\'")}'`;
        }
    }
    
    if (originalQuote === '"') {
        return `"${value.replace(/"/g, '\\"')}"`;
    } else if (originalQuote === "'") {
        return `'${value.replace(/'/g, "\\'")}'`;
    }
    
    return value;
}

function mergeEnvSecrets(existingContent: string, secrets: Record<string, string>): string {
    const eol = existingContent.includes('\r\n') ? '\r\n' : '\n';
    const blocks = parseEnv(existingContent, eol);
    const updatedKeys = new Set<string>();
    const resultLines: string[] = [];

    for (const block of blocks) {
        if (block.type === 'key-value' && block.key) {
            const key = block.key;
            if (Object.prototype.hasOwnProperty.call(secrets, key)) {
                const value = secrets[key];
                resultLines.push(
                    block.leadingWhitespace +
                    key +
                    block.middleWhitespace +
                    formatEnvValue(value, block.quote) +
                    block.comment
                );
                updatedKeys.add(key);
                continue;
            }
        }
        resultLines.push(block.raw);
    }

    const newKeys = Object.keys(secrets).filter((k) => !updatedKeys.has(k));
    if (newKeys.length > 0) {
        if (resultLines.length > 0 && resultLines[resultLines.length - 1].trim() !== '') {
            resultLines.push('');
        }
        for (const key of newKeys) {
            const value = secrets[key];
            resultLines.push(key + '=' + formatEnvValue(value));
        }
    }

    return resultLines.join(eol);
}

function getKeysWhitelist(optionsKeys?: string, config?: { keys?: string[]; syncKeys?: string[] } | null): Set<string> | null {
    if (optionsKeys) {
        const keys = optionsKeys.split(',')
            .map(k => k.trim())
            .filter(k => k.length > 0);
        return keys.length > 0 ? new Set(keys) : null;
    }
    
    if (config) {
        const keys = config.keys || config.syncKeys;
        if (Array.isArray(keys)) {
            const normalized = keys
                .map(k => typeof k === 'string' ? k.trim() : '')
                .filter(k => k.length > 0);
            return normalized.length > 0 ? new Set(normalized) : null;
        }
    }
    
    return null;
}
