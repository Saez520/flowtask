/**
 * Deterministic operator catalog for the authority pause and repair flow.
 *
 * The strings are the operator channel: they say what is missing, why it is
 * missing, and the exact next step. They contain no internal codes, paths,
 * layer names, or coordination identifiers. The technical channel (structured
 * `errors[]` with `code`, `layer`, `path`, and `reason`) is delivered only when
 * the operator asks for a diagnosis.
 */
export const AUTHORITY_MESSAGES = Object.freeze({
  authority_block:
    "Falta tu autorización para continuar: la configuración de permisos quedó vacía o no es válida.\n" +
    "Para seguir, respondé «restaurar» y la reparo por vos.",
  repaired: "La autorización quedó restaurada. La ejecución puede continuar.",
  repair_failed:
    "No pude restaurar la autorización.\n" +
    "Para seguir, reinstalá el producto o pedime un diagnóstico.",
  not_installed:
    "La autorización no está configurada.\n" +
    "Para seguir, reinstalá el producto o pedime un diagnóstico.",
  healthy: "La autorización está disponible.",
});
