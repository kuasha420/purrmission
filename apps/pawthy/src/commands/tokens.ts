import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import { getToken, getApiUrl } from '../config.js';
import { createPawthyCorrelationContext, pawthyRequestHeaders } from '../correlation.js';

export interface CredentialSummary {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  lastUsedAt: string | null;
}

export const tokensCommand = new Command('tokens')
  .alias('token')
  .description('Manage user-scoped Pawthy tokens and credentials');

tokensCommand
  .command('list')
  .alias('ls')
  .description('List all credentials and active sessions for the authenticated user')
  .action(async () => {
    const token = getToken();
    const apiUrl = getApiUrl();
    const correlation = createPawthyCorrelationContext();

    if (!token) {
      console.error(chalk.red('You must be logged in. Run `pawthy login` first.'));
      process.exit(1);
      return;
    }

    try {
      console.log(chalk.dim('Fetching credentials...'));
      const res = await axios.get<CredentialSummary[]>(`${apiUrl}/api/auth/credentials`, {
        headers: pawthyRequestHeaders(correlation, { Authorization: `Bearer ${token}` }),
      });

      const credentials = res.data;
      if (!Array.isArray(credentials) || credentials.length === 0) {
        console.log(chalk.yellow('No credentials found for current user.'));
        return;
      }

      console.log(chalk.bold(`\nFound ${credentials.length} credential(s):\n`));

      for (const cred of credentials) {
        const isRevoked = Boolean(cred.revokedAt);
        const status = isRevoked
          ? chalk.red(`REVOKED (${cred.revokedReason || 'revoked'})`)
          : chalk.green('ACTIVE');

        const createdAtStr = formatTimestamp(cred.createdAt, 'N/A');
        const expiresAtStr = formatTimestamp(cred.expiresAt, 'Never');
        const lastUsedStr = formatTimestamp(cred.lastUsedAt, 'Never');

        // Plaintext, prefix, and digest are strictly excluded from output
        console.log(`• ${chalk.cyan(cred.name)} (${status})`);
        console.log(`  ID:         ${cred.id}`);
        console.log(`  Type:       ${cred.type}`);
        console.log(`  Created:    ${createdAtStr}`);
        console.log(`  Expires:    ${expiresAtStr}`);
        console.log(`  Last Used:  ${lastUsedStr}`);
        if (isRevoked && cred.revokedAt) {
          console.log(`  Revoked At: ${formatTimestamp(cred.revokedAt, 'N/A')}`);
        }
        console.log('');
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          console.error(chalk.red('Session expired or revoked. Please run `pawthy login` again.'));
        } else if (error.response?.status === 403) {
          console.error(chalk.red('Access forbidden: Insufficient permissions or wrong audience.'));
        } else {
          console.error(
            chalk.red(
              `Failed to list credentials: ${error.message} (Correlation ID: ${correlation.commandId})`
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

tokensCommand
  .command('revoke <credentialId>')
  .alias('rm')
  .alias('delete')
  .description('Revoke a credential by its ID')
  .action(async (credentialId: string) => {
    const token = getToken();
    const apiUrl = getApiUrl();
    const correlation = createPawthyCorrelationContext();

    if (!token) {
      console.error(chalk.red('You must be logged in. Run `pawthy login` first.'));
      process.exit(1);
      return;
    }

    if (!credentialId || credentialId.trim().length === 0) {
      console.error(chalk.red('Credential ID is required.'));
      process.exit(1);
      return;
    }

    try {
      console.log(chalk.dim(`Revoking credential ${credentialId}...`));
      await axios.delete(`${apiUrl}/api/auth/credentials/${credentialId.trim()}`, {
        headers: pawthyRequestHeaders(correlation, { Authorization: `Bearer ${token}` }),
      });

      console.log(chalk.green(`\n✅ Credential ${credentialId} has been successfully revoked.`));
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          console.error(chalk.red('Session expired or revoked. Please run `pawthy login` again.'));
        } else if (error.response?.status === 403) {
          console.error(
            chalk.red('Access forbidden: You do not have permission to revoke this credential.')
          );
        } else if (error.response?.status === 404) {
          console.error(chalk.red(`Credential ${credentialId} not found.`));
        } else {
          console.error(
            chalk.red(
              `Failed to revoke credential: ${error.message} (Correlation ID: ${correlation.commandId})`
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

function formatTimestamp(val: string | null | undefined, fallback: string): string {
  if (!val) return fallback;
  const d = new Date(val);
  return isNaN(d.getTime()) ? String(val) : d.toISOString();
}
