#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { install, update } from "./lib/installer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directorio raíz de FlowTask (un nivel arriba de bin/)
export const FLOWTASK_DIR = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const command = args[0] || "install";

switch (command) {
  case "install":
    install(FLOWTASK_DIR);
    break;

  case "update":
    update(FLOWTASK_DIR);
    break;

  case "--help":
  case "-h":
    console.log(`
FlowTask CLI

Usage:
  flowtask install    Install FlowTask in the current project
  flowtask update     Update FlowTask files (delta-only sync)
  flowtask --help     Show this help message
  flowtask --version  Show version

Examples:
  flowtask install    Install FlowTask in current directory
  flowtask update     Update existing FlowTask installation
    `);
    break;

  case "--version":
  case "-v": {
    const pkgPath = path.join(FLOWTASK_DIR, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    console.log(pkg.version);
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run 'flowtask --help' for usage information.");
    process.exit(1);
}
