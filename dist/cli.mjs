#!/usr/bin/env node
// CLI entry point - auto-generated, do not edit
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { runCli } = await import(join(__dirname, 'cli.js'));
runCli(process.argv.slice(2));
