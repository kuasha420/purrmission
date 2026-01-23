#!/usr/bin/env node
import { Command } from "commander";
import { loginCommand } from './commands/login.js';
import { initCommand } from './commands/init.js';
import { pushCommand } from './commands/push.js';
import { pullCommand } from './commands/pull.js';

const program = new Command();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));

program
    .name("pawthy")
    .description("Official CLI for Purrmission Credential Sync")
    .version(packageJson.version);

program.addCommand(loginCommand);
program.addCommand(initCommand);
program.addCommand(pushCommand);
program.addCommand(pullCommand);

program.parse(process.argv);
