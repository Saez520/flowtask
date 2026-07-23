import fs from "fs";
import path from "path";

// ─── Local query tool ─────────────────────────────────────────────────────────

/**
 * Herramienta local de consulta del grafo.
 *
 * Lee `graphify-out/graph.json` directamente, aplica búsqueda literal
 * case-insensitive sobre nombres/rutas/símbolos disponibles en el JSON
 * y devuelve coincidencias deterministas.
 *
 * Contrato de salida JSON:
 *   { ok: boolean, source: "local", query: string, results: array, diagnostic: string|null }
 *
 * Exit codes:
 *   0 — éxito (incluso sin coincidencias)
 *   1 — cualquier fallo local (query vacía, JSON ausente/inválido, error de lectura)
 *
 * @param {string} projectDir - Raíz del repositorio principal
 * @param {string} queryString - Query string no vacía
 * @param {object} [opts]
 * @param {Function} [opts.existsSyncFn] - override fs.existsSync (testing)
 * @param {Function} [opts.readFileSyncFn] - override fs.readFileSync (testing)
 * @returns {{ ok: boolean, source: "local", query: string, results: Array<{name: string, path: string|null, type: string|null}>, diagnostic: string|null }}
 */
export function queryLocalGraph(projectDir, queryString, opts = {}) {
  const existsSync = opts.existsSyncFn ?? fs.existsSync;
  const readFileSync = opts.readFileSyncFn ?? fs.readFileSync;

  // ── Validate query ─────────────────────────────────────────────────────
  if (!queryString || typeof queryString !== "string" || queryString.trim() === "") {
    return {
      ok: false,
      source: "local",
      query: queryString || "",
      results: [],
      diagnostic: "Query vacía o inválida. Proporciona una cadena de búsqueda no vacía.",
    };
  }

  const trimmedQuery = queryString.trim();

  // ── Locate graph file ──────────────────────────────────────────────────
  const graphPath = path.join(projectDir, "graphify-out", "graph.json");

  if (!existsSync(graphPath)) {
    return {
      ok: false,
      source: "local",
      query: trimmedQuery,
      results: [],
      diagnostic: `Archivo de grafo no encontrado: ${graphPath}. Ejecuta graphify extract primero.`,
    };
  }

  // ── Read and parse graph ───────────────────────────────────────────────
  let graphData;
  try {
    const raw = readFileSync(graphPath, "utf8");
    graphData = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        ok: false,
        source: "local",
        query: trimmedQuery,
        results: [],
        diagnostic: `JSON inválido en ${graphPath}: ${err.message}.`,
      };
    }
    return {
      ok: false,
      source: "local",
      query: trimmedQuery,
      results: [],
      diagnostic: `Error de lectura de ${graphPath}: ${err.message}.`,
    };
  }

  // ── Search ─────────────────────────────────────────────────────────────
  const results = searchGraph(graphData, trimmedQuery);

  return {
    ok: true,
    source: "local",
    query: trimmedQuery,
    results,
    diagnostic: null,
  };
}

/**
 * Search a graph data structure for literal case-insensitive matches.
 * Supports common graph JSON shapes: arrays of nodes, nested objects with
 * name/path/symbol fields, and top-level key-value maps.
 *
 * @param {object|Array} graphData - Parsed graph JSON
 * @param {string} query - Lowercased search term
 * @returns {Array<{name: string, path: string|null, type: string|null}>}
 */
function searchGraph(graphData, query) {
  const results = [];
  const lowerQuery = query.toLowerCase();

  if (Array.isArray(graphData)) {
    // Array of nodes/entries
    for (const item of graphData) {
      const match = matchItem(item, lowerQuery);
      if (match) results.push(match);
    }
  } else if (typeof graphData === "object" && graphData !== null) {
    // Object with possible nodes/symbols/entries arrays or key-value maps
    const candidateArrays = extractCandidateArrays(graphData);
    for (const item of candidateArrays) {
      const match = matchItem(item, lowerQuery);
      if (match) results.push(match);
    }
  }

  return results;
}

/**
 * Extract all array values from the top-level and one level deep of an object.
 */
function extractCandidateArrays(obj) {
  const items = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      items.push(...value);
    } else if (typeof value === "object" && value !== null) {
      // One level deep
      for (const [subKey, subValue] of Object.entries(value)) {
        if (Array.isArray(subValue)) {
          items.push(...subValue);
        }
      }
    }
  }
  return items;
}

/**
 * Check if an item matches the query on name/path/symbol fields.
 * Returns a normalized result object or null.
 */
function matchItem(item, lowerQuery) {
  if (typeof item !== "object" || item === null) return null;

  const name = item.name || item.symbol || item.id || null;
  const filePath = item.path || item.file || item.location || null;
  const type = item.type || item.kind || null;

  // Check name
  if (name && typeof name === "string" && name.toLowerCase().includes(lowerQuery)) {
    return { name, path: filePath, type };
  }

  // Check path
  if (filePath && typeof filePath === "string" && filePath.toLowerCase().includes(lowerQuery)) {
    return { name: name || filePath, path: filePath, type };
  }

  // Check symbol
  if (item.symbol && typeof item.symbol === "string" && item.symbol.toLowerCase().includes(lowerQuery)) {
    return { name: item.symbol, path: filePath, type };
  }

  return null;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI handler for `flowtask graphify query --query <query-string>`.
 * Writes JSON to stdout, diagnostics to stderr.
 * Sets exit code 0 for success (even with empty results), 1 for failures.
 *
 * @param {string} projectDir
 * @param {string} queryString
 * @param {object} [opts] - injection for testing
 */
export function runLocalQueryCli(projectDir, queryString, opts = {}) {
  const result = queryLocalGraph(projectDir, queryString, opts);

  // JSON to stdout — always a single line
  const jsonOutput = JSON.stringify(result);
  process.stdout.write(jsonOutput + "\n");

  // Diagnostic to stderr
  if (result.diagnostic) {
    process.stderr.write(`[graphify-query] ${result.diagnostic}\n`);
  }

  // Exit code
  process.exitCode = result.ok ? 0 : 1;
}
