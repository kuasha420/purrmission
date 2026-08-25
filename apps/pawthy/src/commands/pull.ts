import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { getToken, getApiUrl, getProjectConfig } from '../config.js';
import { resolveFileAndFormat, SecretFormat, serializeSecrets } from '../format.js';
import { createPawthyCorrelationContext, pawthyRequestHeaders } from '../correlation.js';

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
  .option('-g, --grant <id>', 'Approval grant ID to redeem')
  .option('--grant-id <id>', 'Approval grant ID to redeem')
  .action(async (options) => {
    const token = getToken();
    const apiUrl = getApiUrl();
    const correlation = createPawthyCorrelationContext();
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

    // Whitelisting / selective keys sync (Issue #80)
    const keysWhitelist = getKeysWhitelist(options.keys, config);
    const keysArray = keysWhitelist ? Array.from(keysWhitelist) : undefined;
    const initialGrantId = options.grant || options.grantId;

    try {
      console.log(chalk.dim('Fetching secrets from Purrmission...'));

      // 1. Reveal Secrets via POST reveal endpoint (PR #158 / #130)
      const revealBody: { keys?: string[]; grantId?: string } = {};
      if (keysArray && keysArray.length > 0) {
        revealBody.keys = keysArray;
      }
      if (initialGrantId) {
        revealBody.grantId = initialGrantId;
      }

      const res = await axios.post<{
        secrets?: Record<string, string>;
        status?: string;
        message?: string;
        requestId?: string;
      }>(`${apiUrl}/api/projects/${projectId}/environments/${envId}/secrets/reveal`, revealBody, {
        headers: pawthyRequestHeaders(correlation, { Authorization: `Bearer ${token}` }),
        validateStatus: (status) => status >= 200 && status < 300,
      });

      let secrets: Record<string, string> = {};

      if (res.status === 202) {
        const requestId = res.data?.requestId;
        if (!requestId || typeof requestId !== 'string') {
          console.error(chalk.red('Received pending approval status without a valid request ID.'));
          process.exit(1);
          return;
        }

        console.log(`\n⏳ ${chalk.yellow('Access Pending Approval')}`);
        console.log(chalk.white(`Request ID: ${requestId}`));
        console.log(chalk.dim('Waiting for Guardian approval in Discord...'));

        const initialIntervalMs = Number(process.env.PAWTHY_POLL_INTERVAL_MS) || 2000;
        const maxIntervalMs = Number(process.env.PAWTHY_POLL_MAX_INTERVAL_MS) || 10000;
        const timeoutMs = Number(process.env.PAWTHY_POLL_TIMEOUT_MS) || 300000;

        let currentInterval = initialIntervalMs;
        const startTime = Date.now();
        let approvedGrantId: string | null = null;

        while (Date.now() - startTime < timeoutMs) {
          await new Promise((resolve) => setTimeout(resolve, currentInterval));

          try {
            const reqRes = await axios.get<{
              requestId: string;
              status: string;
              grantId?: string | null;
              resolvedBy?: string | null;
              resolvedAt?: string | null;
            }>(`${apiUrl}/api/requests/${requestId}`, {
              headers: pawthyRequestHeaders(correlation, { Authorization: `Bearer ${token}` }),
            });

            const reqData = reqRes.data;
            if (reqData.status === 'APPROVED' && reqData.grantId) {
              approvedGrantId = reqData.grantId;
              console.log(chalk.green('\n✅ Request approved! Retrieving secrets...'));
              break;
            } else if (reqData.status === 'DENIED') {
              console.error(
                chalk.red(`\n❌ Access request ${requestId} was denied by a Guardian.`)
              );
              process.exit(1);
              return;
            } else if (reqData.status === 'EXPIRED' || reqData.status === 'CANCELLED') {
              console.error(
                chalk.red(`\n❌ Access request ${requestId} has ${reqData.status.toLowerCase()}.`)
              );
              process.exit(1);
              return;
            }

            currentInterval = Math.min(currentInterval * 1.5, maxIntervalMs);
          } catch (pollError: unknown) {
            if (axios.isAxiosError(pollError)) {
              const status = pollError.response?.status;
              if (status === 401) {
                console.error(chalk.red('\nSession expired during polling. Please log in again.'));
                process.exit(1);
                return;
              } else if (status === 403) {
                console.error(chalk.red(`\nAccess forbidden for request ${requestId}.`));
                process.exit(1);
                return;
              } else if (status === 404) {
                console.error(chalk.red(`\nRequest ${requestId} not found.`));
                process.exit(1);
                return;
              } else if (status === 429) {
                const retryAfterHeader = pollError.response?.headers?.['retry-after'];
                const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
                if (!isNaN(retryAfterSec) && retryAfterSec > 0) {
                  currentInterval = Math.min(retryAfterSec * 1000, maxIntervalMs);
                } else {
                  currentInterval = Math.min(currentInterval * 2, maxIntervalMs);
                }
                continue;
              }
            }
            currentInterval = Math.min(currentInterval * 1.5, maxIntervalMs);
          }
        }

        if (!approvedGrantId) {
          console.error(chalk.red(`\nTimed out waiting for approval of request ${requestId}.`));
          process.exit(1);
          return;
        }

        const finalRevealRes = await axios.post<{ secrets?: Record<string, string> }>(
          `${apiUrl}/api/projects/${projectId}/environments/${envId}/secrets/reveal`,
          {
            ...(keysArray && keysArray.length > 0 ? { keys: keysArray } : {}),
            grantId: approvedGrantId,
          },
          {
            headers: pawthyRequestHeaders(correlation, { Authorization: `Bearer ${token}` }),
          }
        );
        secrets = finalRevealRes.data.secrets || {};
      } else {
        secrets = res.data.secrets || {};
      }

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

        // Safety check if file already exists
        try {
          await fs.access(envPath);
          console.warn(chalk.yellow(`\n⚠️  File ${file} already exists.`));
          console.warn(chalk.yellow('Overwriting existing file...'));
        } catch {
          // File doesn't exist, proceed safe.
        }
      }

      // Write to file
      await fs.writeFile(envPath, content);

      console.log(
        chalk.green(`\n✅ Successfully pulled ${Object.keys(secrets).length} secrets to ${file}`)
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          console.error(chalk.red('Session expired or revoked. Please run `pawthy login` again.'));
        } else if (error.response?.status === 403) {
          console.error(chalk.red('Access forbidden: Insufficient permissions or wrong audience.'));
        } else if (error.response?.status === 404) {
          console.error(chalk.red('Project or Environment not found. It may have been deleted.'));
        } else if (error.response?.status === 405) {
          console.error(
            chalk.red(
              'Method not allowed: Server does not allow secret retrieval via GET. Use POST reveal.'
            )
          );
        } else {
          console.error(
            chalk.red(
              `Failed to pull secrets: ${error.message} (Correlation ID: ${correlation.commandId})`
            )
          );
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
