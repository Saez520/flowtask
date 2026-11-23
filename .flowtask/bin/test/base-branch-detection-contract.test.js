import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// La regla de detección de base vive duplicada en tres skills independientes:
// nada fuera de este contrato fuerza que sigan enunciando lo mismo.
const BASE_DETECTION_SKILLS = [
  ".flowtask/skills/runner-flow-ejecucion-ca/SKILL.md",
  ".flowtask/skills/runner-flow-hotfix/SKILL.md",
  ".flowtask/skills/handshake-protocol/SKILL.md",
];

// Las skills son Markdown con wrap arbitrario: se aplana el whitespace para que
// un literal reintroducido no escape por un salto de línea.
const flat = (text) => text.replace(/\s+/g, " ");

// gap: G1 — una skill reintroduce `trunk → main` o pierde `origin/HEAD`.
test("las tres skills canónicas enuncian la misma regla de detección de base", () => {
  for (const skillPath of BASE_DETECTION_SKILLS) {
    const text = flat(fs.readFileSync(path.join(ROOT, skillPath), "utf8"));

    assert.equal(
      text.includes("trunk → main"),
      false,
      `${skillPath} reintroduce "trunk → main"; la regla canónica detecta la base por origin/HEAD`,
    );
    assert.equal(
      text.includes("origin/HEAD"),
      true,
      `${skillPath} perdió "origin/HEAD"; la regla canónica detecta la base por origin/HEAD`,
    );
  }
});
