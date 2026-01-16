#!/usr/bin/env node
import { Command } from "commander";
import boxen from "boxen";
import chalk from "chalk";

import { loginCommand } from './commands/login.js';

const program = new Command();

program
    .name("pawthy")
    .description("Official CLI for Purrmission Credential Sync")
    .version("0.1.0");

program.addCommand(loginCommand);

program
    .command("init")
    .description("Initialize a new project")
    .action(async () => {
        console.log(chalk.blue("Init command coming soon..."));
    });

program.parse(process.argv);
