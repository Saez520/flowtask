import fs from "node:fs";
import path from "node:path";
import { composeRunnerDocument } from "../../lib/runner-flows.js";

/**
 * Compose the canonical runner document from the permanent core plus the flows
 * declared by its index. Tests use this helper so a rule moved to a flow keeps
 * its coverage; installation still ships core and flows separately.
 */
export function readComposedRunner({ root }) {
  const flowtaskDir = path.join(root, ".flowtask");
  const runnerBody = fs.readFileSync(path.join(flowtaskDir, "agents", "runner.md"), "utf8");
  return composeRunnerDocument({ runnerBody, skillsDir: path.join(flowtaskDir, "skills") });
}
