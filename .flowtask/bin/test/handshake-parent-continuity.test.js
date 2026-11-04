import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readComposedRunner } from "./helpers/runner-document.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const flowtaskDir = path.resolve(testDir, "../..");
const root = path.resolve(flowtaskDir, "..");

// Los documentos son markdown con saltos de línea arbitrarios: se normaliza el
// espacio para que las aserciones verifiquen contenido, no wrap.
const normalize = (content) => content.replace(/\s+/g, " ");

const runner = normalize(readComposedRunner({ root }));
const handshake = normalize(fs.readFileSync(path.join(flowtaskDir, "skills/handshake-protocol/SKILL.md"), "utf8"));
const checkpoint = normalize(fs.readFileSync(path.join(flowtaskDir, "skills/checkpoint-mixin/SKILL.md"), "utf8"));

const PARENT_MISMATCH = "is not a child of the current session";

function section(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  assert.notEqual(start, -1, `no se encontró la sección: ${startMarker}`);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `no se encontró el cierre de la sección: ${endMarker}`);
  return content.slice(start, end);
}

const selfHealing = section(
  runner,
  "### Recuperación ante Fallos (Self-Healing)",
  "La rama prioritaria de revisión de un CA formalizado",
);

const caReview = section(
  runner,
  "### Rama prioritaria — revisión de un CA formalizado",
  "### Paso 2 — Planificación",
);

const delegationFlow = section(
  runner,
  "Flujo de delegación — con continuidad explícita acotada:",
  "## Contrato de ensamblado de prompts de delegación",
);

describe("Continuidad de subagentes ante parent mismatch", () => {
  it("trata el rechazo por relación de padre como una clase de error propia", () => {
    assert.ok(runner.includes(PARENT_MISMATCH), "runner.md debe nombrar el rechazo de relación de padre");
    assert.ok(handshake.includes(PARENT_MISMATCH), "handshake-protocol debe nombrar el rechazo de relación de padre");
    assert.match(runner, /parent mismatch/);
    assert.match(handshake, /parent mismatch/);
    assert.match(checkpoint, /relación de padre/);
  });

  it("distingue el parent mismatch de la sesión inexistente o expirada", () => {
    assert.ok(
      selfHealing.includes(
        "la sesión existe pero no es hija del padre actual: es un parent mismatch, no una sesión inexistente o expirada.",
      ),
      "el parent mismatch no debe confundirse con la sesión inexistente o expirada",
    );
    assert.ok(
      selfHealing.includes(
        "retorna un error indicando que el hilo no existe o ha expirado:",
      ),
      "la clase de sesión inexistente o expirada debe conservar su redacción vigente",
    );
  });

  it("aplica un fallback acotado de child nuevo con restauración de checkpoint", () => {
    assert.ok(
      selfHealing.includes(
        "Conservar el `task_id` como referencia histórica, no purgar el identificador y no reintentar el mismo `sessionID`. `ca-writer` y `planner` abren un child nuevo y restauran el estado desde el checkpoint de Engram; `constructor` solo continúa con un child nuevo cuando su checkpoint es restaurable",
      ),
      "el fallback debe abrir un child nuevo y restaurar el checkpoint",
    );
    assert.ok(
      handshake.includes(
        "el rechazo es un parent mismatch y no una sesión inexistente o expirada: el orquestador abre un child nuevo en Escenario A y restaura el estado desde el checkpoint de Engram, sin reintentar el mismo `sessionID` y sin presentar el child nuevo como reanudación literal.",
      ),
      "handshake-protocol debe documentar el mismo fallback acotado",
    );
    assert.ok(
      checkpoint.includes(
        "Si la herramienta rechaza la relación de padre (`is not a child of the current session`), la continuidad se materializa en un child nuevo con restauración del checkpoint.",
      ),
      "el tratamiento completo debe continuar en child nuevo con restauración del checkpoint",
    );
  });

  it("no purga el identificador histórico ni reintenta el mismo sessionID", () => {
    assert.match(
      selfHealing,
      /no purgar el identificador y no reintentar el mismo `sessionID`/,
      "el parent mismatch no debe purgar el task_id ni reintentar el sessionID rechazado",
    );
    assert.ok(
      runner.includes("Conservar el `task_id` como referencia histórica"),
      "el identificador se conserva como referencia histórica",
    );
    assert.ok(
      handshake.includes("sin reintentar el mismo `sessionID`"),
      "handshake-protocol debe prohibir el reintento con el mismo sessionID",
    );
  });

  it("prohíbe presentar el child nuevo como reanudación literal", () => {
    assert.ok(runner.includes("no presentar el child nuevo como reanudación literal"));
    assert.ok(runner.includes("El child nuevo no se comunica como reanudación literal."));
    assert.ok(handshake.includes("sin presentar el child nuevo como reanudación literal"));
  });

  it("declara el task_id como referencia histórica sin garantía de sessionID elegible", () => {
    assert.ok(
      handshake.includes(
        "| `task_id` | `string \\| null` | Identificador histórico del hilo (Escenario B), o `null` para nuevo hilo (Escenario A). No garantiza que la herramienta lo admita como `sessionID` desde el padre actual. |",
      ),
      "el contrato de salida debe aclarar que el task_id no garantiza sessionID elegible",
    );
    assert.ok(runner.includes("identificador como referencia histórica"));
  });

  it("no relaja la rama de revisión de un CA formalizado", () => {
    assert.ok(
      caReview.includes("informa la pérdida de continuidad y detiene la revisión"),
      "la revisión de CA formalizado mantiene el hard stop vigente",
    );
    assert.doesNotMatch(
      caReview,
      /parent mismatch|child nuevo|is not a child of the current session/,
      "la revisión de CA formalizado no admite fallback por parent mismatch",
    );
  });

  it("distingue el parent mismatch en toda ruta que reutiliza un task_id", () => {
    assert.ok(
      delegationFlow.includes(
        "Si OpenCode rechaza la relación de padre (`is not a child of the current session`), conservas el identificador como referencia histórica, abres un child nuevo con el prompt delegable y la restauración explícita del checkpoint, declaras que no hubo reanudación literal y no reintentes el mismo `sessionID`.",
      ),
      "el flujo de delegación debe distinguir el parent mismatch",
    );
    assert.ok(
      runner.includes(
        "Si OpenCode responde que la sesión no es hija del padre actual (`is not a child of the current session`), el rechazo es un parent mismatch: el Runner conserva el identificador como referencia histórica, abre un child nuevo con el prompt delegable y la restauración explícita del checkpoint, comunica que no hubo reanudación literal y no reintenta el mismo `sessionID`.",
      ),
      "la rama prioritaria de continuidad debe distinguir el parent mismatch",
    );
    assert.ok(
      runner.includes(
        "- Invocar `subagent()` usando el `task_id` persistido como `sessionID`. - Si OpenCode rechaza la relación de padre (`is not a child of the current session`), el rechazo es un parent mismatch: `ca-writer` y `planner` abren un child nuevo en Escenario A y restauran el estado desde el checkpoint de Engram; `constructor` solo continúa con un child nuevo cuando su checkpoint es restaurable; en cualquier otro caso informar pérdida de continuidad y detener.",
      ),
      "Escenario B debe distinguir el parent mismatch",
    );
  });
});
