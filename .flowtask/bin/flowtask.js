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

const PERSONA_LEVELS = ["training", "mid", "senior", "custom"];

function parseOptions(commandArgs) {
  const options = {};
  const personaIndex = commandArgs.indexOf("--persona");
  if (personaIndex === -1) return options;

  const value = commandArgs[personaIndex + 1];
  if (!PERSONA_LEVELS.includes(value)) {
    throw new Error(`--persona debe ser uno de: ${PERSONA_LEVELS.join(", ")}`);
  }
  options.persona = value;
  return options;
}

let options;
try {
  options = parseOptions(args.slice(1));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

switch (command) {
  case "install":
    install(FLOWTASK_DIR, options);
    break;

  case "update":
    update(FLOWTASK_DIR, options);
    break;

  case "graphify": {
    // Legacy compatibility shim: graphify query no longer runs local queries.
    const subCommand = args[1];
    if (subCommand === "query") {
      process.stderr.write(
        "[graphify] Deprecated: graphify query ya no ejecuta consultas locales. " +
        "Usa graphify_query_graph por MCP; si no está disponible, escala al Inspector " +
        "o usa la búsqueda normal del proyecto.\n",
      );
      process.exitCode = 1;
    } else {
      process.stderr.write(`[graphify] Subcomando desconocido: ${subCommand}. Usa: graphify query (deprecated).\n`);
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
  flowtask install --persona <training|mid|senior|custom>
                      Select the agent personality explicitly
  flowtask update     Update FlowTask files (delta-only sync)
  flowtask update --persona <training|mid|senior|custom>
  flowtask graphify query --query <q>  Deprecated shim; no local query is executed
  flowtask --help     Show this help message
  flowtask --version  Show version

Examples:
  flowtask install    Install FlowTask in current directory
  flowtask update     Update existing FlowTask installation
  flowtask graphify query --query UserService  Deprecated; use Graphify MCP
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
