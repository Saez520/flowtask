/**
 * FlowTask Classifier — Categoriza el input del usuario en tipos de intención.
 *
 * Orden de prioridad (estricto):
 *   1. COMMAND      — Comandos FlowTask (/run, /inspect, etc.)
 *   2. CA_MENTION   — Referencia a un CA específico (CA-onboarder-agent)
 *   3. PROJECT_QUESTION — Pregunta sobre el proyecto
 *   4. CHANGE_REQUEST   — Solicitud de cambio
 *   5. Fallback     — null si es ambiguo (conservador)
 *
 * Principios:
 *   - Clasificación conservadora: si hay duda, retorna null
 *   - Keywords bilingües (ES + EN)
 *   - Sin dependencias externas — utility pura
 */
/**
 * Classifies user input into FlowTask intention categories.
 *
 * @param input - Raw user input string
 * @returns Category string or null if ambiguous
 *
 * @example
 * classify('/run CA-MIGRACION-DB')       // → 'COMMAND:/run CA-MIGRACION-DB'
 * classify('Revisa CA-MIGRACION-DB')    // → 'CA_MENTION:MIGRACION-DB'
 * classify('¿Qué hace esto?')  // → 'PROJECT_QUESTION'
 * classify('agrega un botón')  // → 'CHANGE_REQUEST'
 * classify('hola mundo')       // → null (ambiguo)
 * classify('')                 // → null
 */
export default function classify(input: string): string | null;
