/**
 * Deterministic operator catalog for the authority pause and repair flow.
 *
 * The strings are the operator channel: they contain no internal codes, paths,
 * layer names, or coordination identifiers. The technical channel (structured
 * `errors[]` with `code`, `layer`, `path`, and `reason`) is delivered only when
 * the operator asks for a diagnosis.
 */
export const AUTHORITY_MESSAGES = Object.freeze({
  authority_block:
    "Falta la autorización para continuar.\n" +
    "Acción: restaurar con la configuración segura.\n" +
    "Respondé «restaurar» para continuar.",
  repaired: "La autorización quedó restaurada. La ejecución puede continuar.",
  repair_failed:
    "No se pudo restaurar la configuración segura.\n" +
    "Acción: reinstalar el producto o generar un diagnóstico.",
  not_installed:
    "La configuración de autorización no está disponible.\n" +
    "Acción: reinstalar el producto o generar un diagnóstico.",
  healthy: "La autorización está disponible.",
});
