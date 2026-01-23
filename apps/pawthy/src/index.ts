#!/usr/bin/env node
import { Command } from "commander";
import packageJson from '../package.json' with { type: 'json' };
import { loginCommand } from './commands/login.js';
import { initCommand } from './commands/init.js';
import { pushCommand } from './commands/push.js';
import { pullCommand } from './commands/pull.js';

const program = new Command();

program
    .name("pawthy")
    .description("Official CLI for Purrmission Credential Sync")
    .version(packageJson.version);

program.addCommand(loginCommand);
program.addCommand(initCommand);
program.addCommand(pushCommand);
program.addCommand(pullCommand);

program.parse(process.argv);
