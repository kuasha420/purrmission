import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { getToken, getApiUrl, getProjectConfig } from '../config.js';
import { resolveFileAndFormat, SecretFormat, serializeSecrets } from '../format.js';

export const pullCommand = new Command('pull')
  .description('Pull secrets from Purrmission to local secret file')
  .option(
    '-f, --file <path>',
    'Path to secret file (default: .env, secrets.json, secrets.yaml, or secrets.toml depending on format)'
  )
  .option('-F, --format <format>', 'Secret file format (env, json, yaml, toml)')
  .option('-E, --env <environment>', 'Environment variant (e.g. development, production)')
  .option('-p, --project-id <id>', 'Project ID')
  .option('-e, --env-id <id>', 'Environment ID')
  .option('-m, --merge', 'Merge with existing file instead of overwriting')
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
    let config: {
      projectId?: string;
      envId?: string;
      keys?: string[];
      syncKeys?: string[];
    } | null = null;

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

    let file: string;
    let format: SecretFormat;
    try {
      const resolved = resolveFileAndFormat(options.file, options.format);
      file = resolved.file;
      format = resolved.format;
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
      return;
    }

    const isFileExplicit = pullCommand.getOptionValueSource('file') === 'cli';
    const isFormatExplicit = pullCommand.getOptionValueSource('format') === 'cli';
    if (options.env && !isFileExplicit && !isFormatExplicit && format === 'env') {
      file = `.env.${options.env}`;
    }

    const envPath = path.resolve(process.cwd(), file);

    try {
      console.log(chalk.dim('Fetching secrets from Purrmission...'));

      // 1. Fetch Secrets
      const res = await axios.get<{
        secrets?: Record<string, string>;
        status?: string;
        message?: string;
      }>(`${apiUrl}/api/projects/${projectId}/environments/${envId}/secrets`, {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: (status) => status >= 200 && status < 300,
      });

      if (res.status === 202) {
        console.log(`\n${chalk.yellow('⏳ Access Pending Approval')}`);
        console.log(chalk.white(res.data.message));
        console.log(
          chalk.dim(
            '\nPlease run this command again once your request has been approved in Discord.'
          )
        );
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
          console.log(
            chalk.yellow(`\n⚠️  Ignored remote keys not in whitelist: ${ignoredKeys.join(', ')}`)
          );
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
          content = serializeSecrets(secrets, format, existingContent);
          isMerged = true;
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw e;
          }
          // File doesn't exist, fallback to regular pull behavior
        }
      }

      if (!isMerged) {
        content = serializeSecrets(secrets, format);

        // 3. Write to file with safety check
        try {
          await fs.access(envPath);
          console.warn(chalk.yellow(`\n⚠️  File ${file} already exists.`));
          console.warn(chalk.yellow('Overwriting existing file...'));
        } catch {
          // File doesn't exist, proceed safe.
        }
      }

      // 3. Write to file
      await fs.writeFile(envPath, content);

      console.log(
        chalk.green(`\n✅ Successfully pulled ${Object.keys(secrets).length} secrets to ${file}`)
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          console.error(chalk.red('Session expired. Please run `pawthy login` again.'));
        } else if (error.response?.status === 403) {
          console.error(
            chalk.red(
              'Access denied. You do not have permission to view secrets in this environment.'
            )
          );
        } else if (error.response?.status === 404) {
          console.error(chalk.red('Project or Environment not found. It may have been deleted.'));
        } else {
          console.error(chalk.red(`Failed to pull secrets: ${error.message}`));
        }
      } else {
        console.error(
          chalk.red(`An error occurred: ${error instanceof Error ? error.message : String(error)}`)
        );
      }
      process.exit(1);
    }
  });

function getKeysWhitelist(
  optionsKeys?: string,
  config?: { keys?: string[]; syncKeys?: string[] } | null
): Set<string> | null {
  if (optionsKeys) {
    const keys = optionsKeys
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    return keys.length > 0 ? new Set(keys) : null;
  }

  if (config) {
    const keys = config.keys || config.syncKeys;
    if (Array.isArray(keys)) {
      const normalized = keys
        .map((k) => (typeof k === 'string' ? k.trim() : ''))
        .filter((k) => k.length > 0);
      return normalized.length > 0 ? new Set(normalized) : null;
    }
  }

  return null;
}
