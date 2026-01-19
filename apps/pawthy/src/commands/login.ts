import { Command } from 'commander';
import axios from 'axios';
import boxen from 'boxen';
import chalk from 'chalk';
import { getApiUrl, setToken } from '../config.js';

export const loginCommand = new Command('login')
    .description('Authenticate with Purrmission using Device Flow')
    .action(async () => {
        const apiUrl = getApiUrl();
        console.log(chalk.dim(`Connecting to ${apiUrl}...`));

        try {
            // 1. Initiate Device Flow
            const initResponse = await axios.post<{
                device_code: string;
                user_code: string;
                verification_uri: string;
                expires_in: number;
                interval: number;
            }>(`${apiUrl}/api/auth/device/code`, {});

            const { device_code, user_code, verification_uri, interval } = initResponse.data;

            // 2. Display Code to User
            console.log(
                boxen(
                    `${chalk.bold('Authenticate to Pawthy')}\n\n` +
                    `1. Run this command in Discord:\n` +
                    `   ${chalk.cyan(`/purrmission cli-login code:${user_code}`)}\n\n` +
                    `2. Or visit: ${chalk.cyan(verification_uri)}`,
                    {
                        padding: 1,
                        margin: 1,
                        borderColor: 'green',
                        borderStyle: 'round',
                    }
                )
            );

            console.log('Waiting for approval...');

            // 3. Poll for Token
            const pollInterval = (interval || 5) * 1000;
            const expiresInMs = (initResponse.data.expires_in || 1800) * 1000;
            const startTime = Date.now();

            const poll = async () => {
                if (Date.now() - startTime > expiresInMs) {
                    console.error(chalk.red('\nAuthentication timed out. Please try again.'));
                    process.exit(1);
                }

                try {
                    const tokenResponse = await axios.post<{
                        access_token: string;
                        token_type: string;
                        expires_in: number;
                    }>(`${apiUrl}/api/auth/token`, {
                        device_code,
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    });

                    const { access_token } = tokenResponse.data;
                    setToken(access_token);
                    console.log(chalk.green('\nSuccessfully authenticated! 🎉'));
                    process.exit(0);

                } catch (error) {
                    if (axios.isAxiosError(error) && error.response && error.response.data) {
                        const errorData = error.response.data as { error?: string };
                        const errorCode = errorData.error;

                        if (errorCode === 'authorization_pending') {
                            // Continue polling
                            setTimeout(poll, pollInterval);
                        } else if (errorCode === 'slow_down') {
                            // Slow down
                            setTimeout(poll, pollInterval * 2);
                        } else if (errorCode === 'expired_token') {
                            console.error(chalk.red('\nSession expired. Please try again.'));
                            process.exit(1);
                        } else if (errorCode === 'access_denied') {
                            console.error(chalk.red('\nAccess denied by user.'));
                            process.exit(1);
                        } else {
                            console.error(chalk.red(`\nAuthentication failed: ${errorCode || 'Unknown error'}`));
                            process.exit(1);
                        }
                    } else {
                        console.error(chalk.red('\nNetwork error during polling.'));
                        process.exit(1);
                    }
                }
            };

            // Start polling
            setTimeout(poll, pollInterval);

        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error(chalk.red(`Failed to initiate login: ${error.message}`));
            } else {
                console.error(chalk.red('An unexpected error occurred.'));
            }
            process.exit(1);
        }
    });
