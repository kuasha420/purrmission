#!/usr/bin/env node
import { Command } from "commander";
import boxen from "boxen";
import chalk from "chalk";

import { loginCommand } from './commands/login.js';

import { initCommand } from './commands/init.js';

const program = new Command();

program
    .name("pawthy")
    .description("Official CLI for Purrmission Credential Sync")
    .version("0.1.0");

program.addCommand(loginCommand);
program.addCommand(initCommand);

program.parse(process.argv);
