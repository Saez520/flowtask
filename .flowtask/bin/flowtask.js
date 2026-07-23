#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { install, update } from "./lib/installer.js";
import { runLocalQueryCli } from "./lib/graphify-local-query.js";

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

  case "graphify": {
    // Sub-command: graphify query --query <query-string>
    const subCommand = args[1];
    if (subCommand === "query") {
      const queryIdx = args.indexOf("--query");
      if (queryIdx === -1 || queryIdx + 1 >= args.length) {
        process.stderr.write("[graphify] Error: --query <query-string> requerido.\n");
        process.exitCode = 1;
        break;
      }
      const queryString = args[queryIdx + 1];
      const projectDir = process.cwd();
      runLocalQueryCli(projectDir, queryString);
    } else {
      process.stderr.write(`[graphify] Subcomando desconocido: ${subCommand}. Usa: graphify query --query <query>\n`);
      process.exitCode = 1;
    }
    break;
  }

  case "--help":
  case "-h":
    console.log(`
FlowTask CLI

Usage:
  flowtask install    Install FlowTask in the current project
  flowtask update     Update FlowTask files (delta-only sync)
  flowtask graphify query --query <q>  Query local code graph (JSON stdout)
  flowtask --help     Show this help message
  flowtask --version  Show version

Examples:
  flowtask install    Install FlowTask in current directory
  flowtask update     Update existing FlowTask installation
  flowtask graphify query --query UserService  Query code graph
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
