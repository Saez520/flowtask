/**
 * FlowTask Classifier — Categoriza el input del usuario en tipos de intención.
 *
 * Orden de prioridad (estricto):
 *   1. COMMAND      — Comandos FlowTask (/run, /inspect, etc.)
 *   2. CA_MENTION   — Referencia a un CA específico (CA-001)
 *   3. PROJECT_QUESTION — Pregunta sobre el proyecto
 *   4. CHANGE_REQUEST   — Solicitud de cambio
 *   5. Fallback     — null si es ambiguo (conservador)
 *
 * Principios:
 *   - Clasificación conservadora: si hay duda, retorna null
 *   - Keywords bilingües (ES + EN)
 *   - Sin dependencias externas — utility pura
 */

// =============================================================================
// CATEGORÍA 1: COMANDOS (prioridad máxima)
// =============================================================================
// Cada patrón captura el ID cuando aplica (ej: /run CA-42)
const COMMAND_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // /run CA-{ID} — ejecutar workflow para un caso de uso
  { pattern: /\/run\s+CA-(\d+)/i, label: 'COMMAND:/run CA-{ID}' },
  // /inspect — explorar el proyecto sin crear CA
  { pattern: /\/inspect/i, label: 'COMMAND:/inspect' },
  // /new-ca — crear un nuevo caso de uso
  { pattern: /\/new-ca/i, label: 'COMMAND:/new-ca' },
  // /evolve-agent — evolucionar un agente FlowTask
  { pattern: /\/evolve-agent/i, label: 'COMMAND:/evolve-agent' },
  // /init — inicializar FlowTask en el proyecto
  { pattern: /\/init/i, label: 'COMMAND:/init' },
  // /status — mostrar estado de FlowTask y Engram
  { pattern: /\/status/i, label: 'COMMAND:/status' },
];

// =============================================================================
// CATEGORÍA 2: CA_MENTION
// =============================================================================
// Detecta referencias a CA con ID numérico: CA-001, CA-42, ca-999
// Usa \b para evitar falsos positivos en palabras como "CASA"
const CA_MENTION_REGEX = /\bCA-(\d+)\b/i;

// =============================================================================
// CATEGORÍA 3: PROJECT_QUESTION
// =============================================================================
// Keywords que indican una pregunta sobre el proyecto.
// Incluye español e inglés. Se comparan en lowercase.
const QUESTION_KEYWORDS = [
  // Español
  '¿',       // signo de apertura de pregunta
  'qué',     // "¿Qué hace esto?"
  'como',    // "como funciona..."
  'cómo',    // "¿Cómo se usa?"
  'por qué', // "¿Por qué falla?"
  'para qué',// "¿Para qué sirve?"
  'cuál',    // "¿Cuál es la diferencia?"
  'cual',    // sin tilde
  'dónde',   // "¿Dónde está el archivo?"
  'donde',   // sin tilde
  // Inglés
  'why',     // "why does this fail?"
  'what',    // "what does this do?"
  'how',     // "how does this work?"
  'explain', // "explain this to me"
  'tell me', // "tell me about..."
  'describe',// "describe the architecture"
];

// =============================================================================
// CATEGORÍA 4: CHANGE_REQUEST
// =============================================================================
// Verbos de acción que indican solicitud de modificación.
// Se comparan en lowercase.
const CHANGE_KEYWORDS = [
  // Español
  'agrega',    // "agrega un endpoint"
  'añade',     // "añade validación"
  'cambia',    // "cambia el formato"
  'crea',      // "crea un servicio"
  'elimina',   // "elimina la clase"
  'borra',     // "borra este archivo"
  'modifica',  // "modifica la lógica"
  'mejora',    // "mejora el rendimiento"
  'corrije',   // "corrije el bug"
  'implementa',// "implementa la feature"
  // Inglés
  'add',       // "add a new endpoint"
  'fix',       // "fix the bug"
  'update',    // "update the config"
  'refactor',  // "refactor this module"
  'remove',    // "remove the unused code"
  'delete',    // "delete this file"
  'optimize',  // "optimize the query"
  'change',    // "change the type"
  'create',    // "create a new service"
  'implement', // "implement the feature"
];

// =============================================================================
// FUNCIÓN PRINCIPAL
// =============================================================================

/**
 * Classifies user input into FlowTask intention categories.
 *
 * @param input - Raw user input string
 * @returns Category string or null if ambiguous
 *
 * @example
 * classify('/run CA-42')       // → 'COMMAND:/run CA-42'
 * classify('Revisa CA-123')    // → 'CA_MENTION:123'
 * classify('¿Qué hace esto?')  // → 'PROJECT_QUESTION'
 * classify('agrega un botón')  // → 'CHANGE_REQUEST'
 * classify('hola mundo')       // → null (ambiguo)
 * classify('')                 // → null
 */
export default function classify(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. COMANDOS — prioridad máxima
  //    Si el input coincide con un comando FlowTask, clasificarlo inmediatamente.
  for (const { pattern, label } of COMMAND_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      // Para /run, inyectar el ID capturado en el label
      if (label.includes('{ID}') && match[1]) {
        return label.replace('{ID}', match[1]);
      }
      return label;
    }
  }

  // 2. CA_MENTION — referencia a un caso de uso
  //    Detectar CA-NNN en cualquier posición del input.
  const caMatch = trimmed.match(CA_MENTION_REGEX);
  if (caMatch) {
    return `CA_MENTION:${caMatch[1]}`;
  }

  // 3. PROJECT_QUESTION — pregunta sobre el proyecto
  //    Buscar keywords de pregunta en el input (case-insensitive).
  const lowerInput = trimmed.toLowerCase();
  if (QUESTION_KEYWORDS.some(kw => lowerInput.includes(kw))) {
    return 'PROJECT_QUESTION';
  }

  // 4. CHANGE_REQUEST — solicitud de cambio
  //    Buscar verbos de acción en el input (case-insensitive).
  if (CHANGE_KEYWORDS.some(kw => lowerInput.includes(kw))) {
    return 'CHANGE_REQUEST';
  }

  // 5. Fallback — conservador: null si no hay match claro
  //    Preferimos null sobre inyectar una categoría incorrecta.
  return null;
}
