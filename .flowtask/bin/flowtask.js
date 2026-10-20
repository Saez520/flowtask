#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { install, update } from "./lib/installer.js";
import {
  PERSONA_LEVELS,
  describeOperationalFailure,
  readLayerSources,
  resolveLayers,
} from "./lib/layers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directorio raíz de FlowTask (un nivel arriba de bin/)
export const FLOWTASK_DIR = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const command = args[0] || "install";

/** Directorio de configuración de capas de cada target, en orden de detección. */
const LAYER_TARGETS = [
  { id: "opencode", dir: ".opencode/flowtask/config" },
  { id: "claude", dir: ".claude/flowtask/config" },
  { id: "vscode", dir: ".vscode/flowtask/config" },
  { id: "standalone", dir: ".flowtask/config" },
];

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

function parseLayersOptions(commandArgs) {
  const options = { target: null, json: false };

  for (let index = 0; index < commandArgs.length; index += 1) {
    const argument = commandArgs[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--target") {
      const value = commandArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--target requiere un valor: opencode, claude, vscode o standalone");
      }
      options.target = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--target=")) {
      options.target = argument.slice("--target=".length);
      continue;
    }
    throw new Error(`Opción desconocida: ${argument}`);
  }

  const known = LAYER_TARGETS.map((target) => target.id);
  if (options.target && !known.includes(options.target)) {
    throw new Error(`--target debe ser uno de: ${known.join(", ")}`);
  }
  return options;
}

function layerValueText(layer, key) {
  if (!layer || layer.status !== "valid" || !layer.value) return null;
  const value = layer.value[key];
  return typeof value === "string" ? value : null;
}

function layerStateText(layer) {
  if (!layer) return "ausente";
  if (layer.status === "valid") return "válida";
  if (layer.status === "invalid") return "inválida";
  return "ausente";
}

function runLayersResolve(commandArgs) {
  let options;
  try {
    options = parseLayersOptions(commandArgs);
  } catch (error) {
    process.stderr.write(`[FlowTask Layers] ${error.message}\n`);
    process.exit(1);
    return;
  }

  const projectDir = process.cwd();
  let target = null;
  let configDir = null;

  if (options.target) {
    const known = LAYER_TARGETS.find((entry) => entry.id === options.target);
    target = known.id;
    configDir = path.join(projectDir, known.dir);
    if (!fs.existsSync(configDir)) {
      process.stderr.write("[FlowTask Layers] No se encontró una configuración de capas en el proyecto actual.\n");
      process.exit(1);
      return;
    }
  } else {
    for (const entry of LAYER_TARGETS) {
      const candidate = path.join(projectDir, entry.dir);
      if (!fs.existsSync(candidate)) continue;
      target = entry.id;
      configDir = candidate;
      break;
    }
    if (!configDir) {
      process.stderr.write("[FlowTask Layers] No se encontró una configuración de capas en el proyecto actual.\n");
      process.exit(1);
      return;
    }
  }

  const project = readLayerSources(configDir);
  const resolution = resolveLayers({ team: null, project });
  const { persona, autonomy, permissions } = resolution.layers;

  if (options.json) {
    const payload = {
      target,
      precedence: resolution.precedence,
      layers: {
        persona: { status: persona.status, value: persona.value, source: persona.source, reason: persona.reason },
        autonomy: { status: autonomy.status, value: autonomy.value, source: autonomy.source, reason: autonomy.reason },
        permissions: { status: permissions.status, value: permissions.value, source: permissions.source, reason: permissions.reason },
      },
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Target: ${target}`);
    console.log(`Persona: ${layerValueText(persona, "persona") ?? layerStateText(persona)} [${persona.source ?? "sin inyección"}]`);
    console.log(`Autonomía: ${layerValueText(autonomy, "profile") ?? layerStateText(autonomy)} [${autonomy.source ?? "sin origen"}]`);
    console.log(`Permisos: ${layerValueText(permissions, "envelope") ?? layerStateText(permissions)} [${permissions.source ?? "sin origen"}]`);
    console.log("Precedencia: permisos > autonomía > persona");
    for (const warning of resolution.warnings) {
      console.log(`Aviso: ${warning}`);
    }
  }

  if (!resolution.operational.ok) {
    process.stderr.write(`${describeOperationalFailure(resolution.operational.errors[0])}\n`);
    process.exit(2);
    return;
  }
  process.exit(0);
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

  case "layers": {
    const subCommand = args[1];
    if (subCommand !== "resolve") {
      process.stderr.write(`[FlowTask Layers] Subcomando desconocido: ${subCommand ?? "(ninguno)"}. Usa: layers resolve.\n`);
      process.exitCode = 1;
      break;
    }
    runLayersResolve(args.slice(2));
    break;
  }

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
  flowtask layers resolve --target <opencode|claude|vscode|standalone>
                      Show the resolved persona, autonomy and permissions layers
  flowtask layers resolve --json
                      Show the resolved layers as JSON
  flowtask graphify query --query <q>  Deprecated shim; no local query is executed
  flowtask --help     Show this help message
  flowtask --version  Show version

Examples:
  flowtask install    Install FlowTask in current directory
  flowtask update     Update existing FlowTask installation
  flowtask layers resolve --target opencode
  flowtask layers resolve --json
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
