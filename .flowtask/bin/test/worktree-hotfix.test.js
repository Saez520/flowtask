import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(ROOT, ".flowtask", "scripts", "worktree.sh");
let tempRepo;

function run(...args) {
  return execFileSync(SCRIPT, args, { cwd: tempRepo, encoding: "utf8", stdio: "pipe" });
}

function git(...args) {
  return execFileSync("git", args, { cwd: tempRepo, encoding: "utf8", stdio: "pipe" });
}

function runResult(...args) {
  const result = spawnSync(SCRIPT, args, { cwd: tempRepo, encoding: "utf8" });
  return { ...result, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function worktreeFor(name) {
  return path.join(tempRepo, ".worktrees", ...name.split("/"));
}

function createCommittedWorktree(name) {
  run("create", name, "--base", "main");
  const worktree = worktreeFor(name);
  fs.writeFileSync(path.join(worktree, "change.txt"), `${name}\n`);
  git("-C", worktree, "add", "change.txt");
  git("-C", worktree, "commit", "-qm", "worktree change");
  return worktree;
}

// Mensaje de rechazo destino-dirty: plantilla fija, única variable permitida es
// el ca_name (parámetro de invocación, nunca dato del repositorio).
function expectedRejection(caName) {
  return (
    `No se puede completar '${caName}': el destino tiene cambios sin commitear.\n` +
    "Inspeccionalo vos mismo con 'git status' antes de reintentar.\n" +
    "El cierre fue cancelado; no se modificó nada.\n"
  );
}

function initTempRepo() {
  tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-worktree-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "FlowTask Test");
  // Espejo del .gitignore real: stamp ignorado (premisa AC2.8) y backups runtime.
  fs.writeFileSync(
    path.join(tempRepo, ".gitignore"),
    ".worktrees/\n.flowtask/config/.review-stamp\n.flowtask/backups/\n"
  );
  fs.writeFileSync(path.join(tempRepo, "file.txt"), "base\n");
  git("add", ".gitignore", "file.txt");
  git("commit", "-qm", "initial");
}

// Crea suciedad en el destino con el nombre hostil indicado, en la categoría pedida.
function createHostileDestination(category, relPath) {
  const abs = path.join(tempRepo, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "hostile\n");
  if (category === "untracked") return;
  git("add", abs);
  if (category === "unstaged") {
    git("commit", "-qm", "track hostile");
    fs.appendFileSync(abs, "modified\n");
  }
}

// Corre un rechazo contra una suciedad de control (nombre normal) y devuelve su
// stderr completo, para comparación byte-idéntica entre casos.
function captureControlRejection(caName) {
  const control = path.join(tempRepo, "control-dirty.txt");
  fs.writeFileSync(control, "control\n");
  const result = runResult("complete", caName, "--base", "main");
  fs.rmSync(control, { force: true });
  assert.equal(result.status, 1);
  return result.stderr;
}

describe("nested hotfix worktrees", () => {
  beforeEach(() => {
    initTempRepo();
  });

  afterEach(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it("creates, lists, completes, and cleans a nested hotfix", () => {
    run("create", "hotfix/test-001", "--base", "main");
    assert.ok(fs.existsSync(path.join(tempRepo, ".worktrees", "hotfix", "test-001")));
    assert.match(git("branch", "--list"), /worktree\/hotfix\/test-001/);
    fs.writeFileSync(path.join(tempRepo, ".worktrees", "hotfix", "test-001", "file.txt"), "fixed\n");
    git("-C", path.join(tempRepo, ".worktrees", "hotfix", "test-001"), "add", "file.txt");
    git("-C", path.join(tempRepo, ".worktrees", "hotfix", "test-001"), "commit", "-qm", "hotfix");
    assert.match(run("list"), /worktree\/hotfix\/test-001/);
    run("complete", "hotfix/test-001", "--base", "main");
    assert.equal(fs.existsSync(path.join(tempRepo, ".worktrees", "hotfix", "test-001")), false);
    assert.doesNotMatch(git("branch", "--list"), /worktree\/hotfix\/test-001/);
    assert.equal(fs.readFileSync(path.join(tempRepo, "file.txt"), "utf8"), "fixed\n");
  });

  it("preserves the hotfix worktree and branch on merge conflict", () => {
    run("create", "hotfix/test-002", "--base", "main");
    const hotfix = path.join(tempRepo, ".worktrees", "hotfix", "test-002");
    fs.writeFileSync(path.join(hotfix, "file.txt"), "hotfix\n");
    git("-C", hotfix, "add", "file.txt");
    git("-C", hotfix, "commit", "-qm", "hotfix conflict");
    fs.writeFileSync(path.join(tempRepo, "file.txt"), "base conflict\n");
    git("add", "file.txt");
    git("commit", "-qm", "base conflict");
    assert.throws(() => run("complete", "hotfix/test-002", "--base", "main"));
    assert.ok(fs.existsSync(hotfix));
    assert.match(git("branch", "--list"), /worktree\/hotfix\/test-002/);
  });

  it("keeps CA identifiers compatible", () => {
    run("create", "CA-legacy", "--base", "main");
    assert.ok(fs.existsSync(path.join(tempRepo, ".worktrees", "CA-legacy")));
    run("cleanup", "CA-legacy", "--base", "main");
    assert.equal(fs.existsSync(path.join(tempRepo, ".worktrees", "CA-legacy")), false);
  });

  for (const name of ["CA-no-commit", "hotfix/no-commit"]) {
    it(`rejects ${name} without a commit and preserves it`, () => {
      run("create", name, "--base", "main");
      const worktree = worktreeFor(name);
      const before = git("rev-parse", "main");
      const result = runResult("complete", name, "--base", "main");

      assert.equal(result.status, 1);
      assert.match(result.stderr, /falta.*commit/i);
      assert.ok(fs.existsSync(worktree));
      assert.match(git("branch", "--list"), new RegExp(`worktree/${name.replace("/", "\\/")}`));
      assert.equal(git("rev-parse", "main"), before);
    });
  }

  for (const name of ["CA-local-changes", "hotfix/local-changes"]) {
    it(`reports all local change categories for ${name}`, () => {
      const worktree = createCommittedWorktree(name);
      fs.writeFileSync(path.join(worktree, "staged.txt"), "staged\n");
      git("-C", worktree, "add", "staged.txt");
      fs.appendFileSync(path.join(worktree, "change.txt"), "unstaged\n");
      fs.writeFileSync(path.join(worktree, "untracked.txt"), "untracked\n");
      const before = git("rev-parse", "main");
      const result = runResult("complete", name, "--base", "main");

      assert.equal(result.status, 1);
      assert.match(result.stderr, /worktree/i);
      assert.match(result.stderr, /staged/i);
      assert.match(result.stderr, /unstaged/i);
      assert.match(result.stderr, /untracked/i);
      assert.match(result.stderr, /crear.*commit/i);
      assert.ok(fs.existsSync(worktree));
      assert.match(git("branch", "--list"), new RegExp(`worktree/${name.replace("/", "\\/")}`));
      assert.equal(git("rev-parse", "main"), before);
    });
  }

  for (const name of ["CA-stash", "hotfix/stash"]) {
    it(`rejects pending stash for ${name}`, () => {
      const worktree = createCommittedWorktree(name);
      fs.writeFileSync(path.join(worktree, "pending.txt"), "pending\n");
      git("-C", worktree, "stash", "push", "-u", "-m", "pending");
      const before = git("rev-parse", "main");
      const result = runResult("complete", name, "--base", "main");

      assert.equal(result.status, 1);
      assert.match(result.stderr, /stash pendiente/i);
      assert.match(result.stderr, /resolver|restaurar/i);
      assert.ok(fs.existsSync(worktree));
      assert.equal(git("rev-parse", "main"), before);
    });
  }

  for (const name of ["CA-dirty-destination", "hotfix/dirty-destination"]) {
    it(`rejects dirty destination for ${name}`, () => {
      const worktree = createCommittedWorktree(name);
      fs.writeFileSync(path.join(tempRepo, "destination-staged.txt"), "staged\n");
      git("add", "destination-staged.txt");
      fs.appendFileSync(path.join(tempRepo, "file.txt"), "unstaged\n");
      fs.writeFileSync(path.join(tempRepo, "destination-untracked.txt"), "untracked\n");
      const before = git("rev-parse", "main");
      const result = runResult("complete", name, "--base", "main");

      assert.equal(result.status, 1);
      assert.equal(result.stderr, expectedRejection(name));
      assert.ok(fs.existsSync(worktree));
      assert.match(git("branch", "--list"), new RegExp(`worktree/${name.replace("/", "\\/")}`));
      assert.equal(git("rev-parse", "main"), before);
      assert.equal(git("stash", "list").trim(), "");
    });
  }

  it("rejects complete bypass options before changing state", () => {
    const worktree = createCommittedWorktree("hotfix/no-force");
    const before = git("rev-parse", "main");
    for (const option of ["--force", "--unknown"]) {
      const result = runResult("complete", "hotfix/no-force", "--base", "main", option);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /opción|argumento|desconocido/i);
    }
    assert.ok(fs.existsSync(worktree));
    assert.match(git("branch", "--list"), /worktree\/hotfix\/no-force/);
    assert.equal(git("rev-parse", "main"), before);
  });
});

// Fixtures hostiles rescatados de #4275/#4262: el mensaje de rechazo debe ser
// invariante ante cualquier nombre legal en git, sin filtrar nunca el nombre.
const HOSTILE_FIXTURES = [
  { label: "espacios", relPath: "archivo con espacios.txt", tokens: ["archivo con espacios.txt", "espacios"] },
  { label: "ene", relPath: "archivo ñandú.txt", tokens: ["ñandú"] },
  { label: "comillas", relPath: `comi'lla"doble.txt`, tokens: [`comi'lla"doble`] },
  { label: "command-subst", relPath: "$(id).txt", tokens: ["$(id)"] },
  { label: "dash-file", relPath: "-dato.txt", tokens: ["-dato"] },
  { label: "dash-exact", relPath: "-", tokens: [] },
  { label: "dash-dir", relPath: "-dir/archivo.txt", tokens: ["-dir/"] },
  { label: "dash-dir-espacios", relPath: "-dir con espacios/archivo.txt", tokens: ["-dir con espacios"] },
  { label: "newline", relPath: "con\nsalto.txt", tokens: ["con\nsalto.txt", "salto"] },
  { label: "tab", relPath: "con\tsalto.txt", tokens: ["con\tsalto.txt", "salto"] },
];

describe("adversarial dirty destination rejection", () => {
  beforeEach(() => {
    initTempRepo();
  });

  afterEach(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  const CA = "CA-adversarial";

  for (const fixture of HOSTILE_FIXTURES) {
    for (const category of ["staged", "unstaged", "untracked"]) {
      it(`rejects ${category} destination named ${fixture.label}`, () => {
        createCommittedWorktree(CA);
        // Control byte-idéntico: mismo ca_name, suciedad de nombre normal.
        const control = captureControlRejection(CA);
        createHostileDestination(category, fixture.relPath);
        const before = git("rev-parse", "main");
        const result = runResult("complete", CA, "--base", "main");

        assert.equal(result.status, 1);
        assert.equal(result.stderr, control);
        assert.ok(fs.existsSync(worktreeFor(CA)));
        assert.match(git("branch", "--list"), /worktree\/CA-adversarial/);
        assert.equal(git("rev-parse", "main"), before);
        assert.equal(git("stash", "list").trim(), "");
        for (const token of fixture.tokens) {
          assert.ok(!result.stdout.includes(token), `stdout filtra ${JSON.stringify(token)}`);
          assert.ok(!result.stderr.includes(token), `stderr filtra ${JSON.stringify(token)}`);
        }
      });
    }
  }
});

// ─── Suite transaccional (--preserve-dirty) ─────────────────────────────────

// Registro de salidas para el barrido anti-exfiltración transversal: en NINGÚN
// camino (rechazo, happy, recover, pending_manual) puede aparecer un token
// hostil de fixture ni convertirse en comando ejecutable.
const CAPTURED_OUTPUTS = [];
function record(result) {
  CAPTURED_OUTPUTS.push({ stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  return result;
}
const EXFIL_TOKENS = [
  "archivo con espacios.txt",
  "ñandú",
  `comi'lla"doble`,
  "$(id)",
  "-dato",
  "-dir/",
  "-dir con espacios",
  "con\nsalto.txt",
  "con\tsalto.txt",
];

function runResultWithEnv(extraEnv, ...args) {
  const result = spawnSync(SCRIPT, args, {
    cwd: tempRepo,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return record({ ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
}

function enableConsent() {
  fs.mkdirSync(path.join(tempRepo, ".flowtask", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRepo, ".flowtask", "config", "worktree.json"),
    JSON.stringify({ preserveDirty: true })
  );
}

// Suciedad mixta estándar: staged nuevo + unstaged sobre tracked + untracked.
function createMixedDirtyDestination(prefix) {
  fs.writeFileSync(path.join(tempRepo, `${prefix}-staged.txt`), "staged\n");
  git("add", `${prefix}-staged.txt`);
  fs.appendFileSync(path.join(tempRepo, "file.txt"), "cambio sin preparar\n");
  fs.writeFileSync(path.join(tempRepo, `${prefix}-untracked.txt`), "untracked\n");
}

function backupsDir() {
  return path.join(tempRepo, ".flowtask", "backups");
}

function backupRefs() {
  return git("for-each-ref", "refs/flowtask/backups", "--format=%(refname)").trim();
}

describe("transactional preservation", () => {
  beforeEach(() => {
    initTempRepo();
  });

  afterEach(() => {
    // Barrido anti-exfiltración transversal sobre TODAS las salidas capturadas.
    for (const out of CAPTURED_OUTPUTS) {
      for (const token of EXFIL_TOKENS) {
        assert.ok(
          !out.stdout.includes(token) && !out.stderr.includes(token),
          `fuga de datos del repo en la salida: ${JSON.stringify(token)}`
        );
      }
    }
    CAPTURED_OUTPUTS.length = 0;
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it("recover without pending transactions is an informative no-op", () => {
    const result = runResult("recover");
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /no hay transacciones/i);
  });

  // AC2.1 — consent gating
  it("rejects dirty destination without any consent and captures nothing", () => {
    createCommittedWorktree("CA-tx-gate");
    createMixedDirtyDestination("gate");
    const before = git("rev-parse", "main");
    const result = runResult("complete", "CA-tx-gate", "--base", "main");

    assert.equal(result.status, 1);
    assert.equal(result.stderr, expectedRejection("CA-tx-gate"));
    assert.equal(fs.existsSync(backupsDir()), false);
    assert.equal(backupRefs(), "");
    assert.equal(git("rev-parse", "main"), before);
  });

  it("preserves with CLI flag alone (AC2.1)", () => {
    createCommittedWorktree("CA-tx-flag");
    createMixedDirtyDestination("flag");
    const result = runResult("complete", "CA-tx-flag", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^preserve: \S+/m);
    assert.match(git("diff", "--cached", "--name-only"), /flag-staged\.txt/);
  });

  it("preserves with persisted config alone (AC2.1)", () => {
    createCommittedWorktree("CA-tx-config");
    createMixedDirtyDestination("cfg");
    enableConsent();
    const result = runResult("complete", "CA-tx-config", "--base", "main");

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^preserve: \S+/m);
  });

  // AC2.2 — happy path mixto con nombres hostiles en las tres categorías
  it("preserves fine-grained state with hostile names in all categories", () => {
    createCommittedWorktree("CA-tx-hostile");
    createHostileDestination("staged", "-dir con espacios/staged ñ.txt");
    createHostileDestination("unstaged", "con\tsalto.txt");
    createHostileDestination("untracked", "$(id).txt");
    const statusBefore = git("status", "--porcelain");
    const result = runResult("complete", "CA-tx-hostile", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 0);
    // Fusión aplicada
    assert.equal(fs.readFileSync(path.join(tempRepo, "change.txt"), "utf8"), "CA-tx-hostile\n");
    // Estado fino: mismo status que antes de la transacción (categorías y contenidos)
    assert.equal(git("status", "--porcelain"), statusBefore);
    // Contenido restaurado byte-idéntico
    assert.equal(
      fs.readFileSync(path.join(tempRepo, "-dir con espacios", "staged ñ.txt"), "utf8"),
      "hostile\n"
    );
    assert.ok(fs.readFileSync(path.join(tempRepo, "con\tsalto.txt"), "utf8").endsWith("modified\n"));
    assert.equal(fs.readFileSync(path.join(tempRepo, "$(id).txt"), "utf8"), "hostile\n");
    // Stash público intacto; backups privados vivos; worktree y branch limpiados
    assert.equal(git("stash", "list").trim(), "");
    assert.ok(backupRefs().length > 0);
    assert.equal(fs.existsSync(worktreeFor("CA-tx-hostile")), false);
    assert.doesNotMatch(git("branch", "--list"), /worktree\/CA-tx-hostile/);
  });

  // AC2.3 — setups no soportados: avisa categoría, no captura nada
  it("rejects with submodules present before capturing anything", () => {
    createCommittedWorktree("CA-tx-sub");
    const upstream = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-upstream-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: upstream });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: upstream });
    execFileSync("git", ["config", "user.name", "FlowTask Test"], { cwd: upstream });
    fs.writeFileSync(path.join(upstream, "lib.txt"), "lib\n");
    execFileSync("git", ["add", "lib.txt"], { cwd: upstream });
    execFileSync("git", ["commit", "-qm", "lib"], { cwd: upstream });
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub"],
      { cwd: tempRepo }
    );
    fs.writeFileSync(path.join(tempRepo, "dirty.txt"), "dirty\n");
    const result = runResult("complete", "CA-tx-sub", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /submodules/);
    assert.equal(backupRefs(), "");
    assert.equal(fs.existsSync(backupsDir()), false);
    assert.ok(fs.readFileSync(path.join(tempRepo, "dirty.txt"), "utf8") === "dirty\n");
    fs.rmSync(upstream, { recursive: true, force: true });
  });

  it("rejects with sparse-checkout active", () => {
    createCommittedWorktree("CA-tx-sparse");
    createMixedDirtyDestination("sp");
    git("sparse-checkout", "init", "--cone");
    const result = runResult("complete", "CA-tx-sparse", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /sparse-checkout/);
    assert.equal(backupRefs(), "");
    assert.equal(fs.existsSync(backupsDir()), false);
  });

  it("rejects when a tracked dirty path has a clean/smudge filter", () => {
    createCommittedWorktree("CA-tx-filter");
    fs.writeFileSync(path.join(tempRepo, ".gitattributes"), "*.bin filter=proceso\n");
    fs.writeFileSync(path.join(tempRepo, "data.bin"), "aaa\n");
    git("add", ".gitattributes", "data.bin");
    const result = runResult("complete", "CA-tx-filter", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /filters/);
    assert.equal(backupRefs(), "");
    assert.equal(fs.existsSync(backupsDir()), false);
  });

  // AC2.4 — interrupción por fase + recuperación idempotente + doble recover
  for (const phase of ["captured", "merge_started", "merged"]) {
    it(`recovers fully after a crash right after ${phase}`, () => {
      createCommittedWorktree("CA-tx-crash");
      createMixedDirtyDestination("crash");
      const statusBefore = git("status", "--porcelain");

      const crashed = runResultWithEnv(
        { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CRASH_AFTER: phase },
        "complete", "CA-tx-crash", "--base", "main", "--preserve-dirty"
      );
      assert.equal(crashed.status, 99);

      // La transacción quedó registrada con sus refs de backup
      assert.ok(backupRefs().length > 0);
      const txId = fs.readdirSync(backupsDir())[0];

      // Recover conduce desde la última fase hasta el estado final correcto
      const rec1 = runResult("recover");
      assert.equal(rec1.status, 0);
      assert.equal(git("status", "--porcelain"), statusBefore);
      assert.equal(
        fs.readFileSync(path.join(tempRepo, "change.txt"), "utf8"),
        "CA-tx-crash\n"
      );
      assert.ok(fs.readFileSync(path.join(tempRepo, "crash-untracked.txt"), "utf8") === "untracked\n");
      assert.equal(git("stash", "list").trim(), "");
      assert.equal(fs.readFileSync(path.join(backupsDir(), txId, "journal"), "utf8"), "restored\n");

      // Doble recover: segunda pasada es no-op seguro con idéntico resultado
      const headAfterFirst = git("rev-parse", "HEAD");
      const statusAfterFirst = git("status", "--porcelain");
      const rec2 = runResult("recover");
      assert.equal(rec2.status, 0);
      assert.equal(git("rev-parse", "HEAD"), headAfterFirst);
      assert.equal(git("status", "--porcelain"), statusAfterFirst);
    });
  }

  // AC2.5 — bloqueo de re-cierre mientras falta restaurar
  it("blocks a new completion while a transaction awaits restoration", () => {
    createCommittedWorktree("CA-tx-open");
    createMixedDirtyDestination("open");
    const crashed = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CRASH_AFTER: "merged" },
      "complete", "CA-tx-open", "--base", "main", "--preserve-dirty"
    );
    assert.equal(crashed.status, 99);
    const txId = fs.readdirSync(backupsDir())[0];
    const headAfterMerge = git("rev-parse", "main");

    // Otro CA limpio intenta cerrar → bloqueado con guía al recover correcto
    createCommittedWorktree("CA-tx-other");
    const blocked = runResult("complete", "CA-tx-other", "--base", "main");
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, new RegExp(`recover ${txId}`));
    assert.equal(git("rev-parse", "main"), headAfterMerge);

    // Resuelta la pendiente, el operador resuelve la suciedad restaurada
    // (el recover la deja en el destino, como corresponde) y el cierre procede.
    run("recover");
    git("reset", "--hard");
    fs.rmSync(path.join(tempRepo, "open-untracked.txt"), { force: true });
    const ok = runResult("complete", "CA-tx-other", "--base", "main");
    assert.equal(ok.status, 0);
    assert.equal(fs.existsSync(worktreeFor("CA-tx-other")), false);
  });

  // AC2.6 — conflicto post-fusión: fusión intacta, backup intacto, pendiente-manual
  it("marks pending-manual on restoration conflict without discarding anything", () => {
    createCommittedWorktree("CA-tx-conflict");
    const worktree = worktreeFor("CA-tx-conflict");
    fs.writeFileSync(path.join(worktree, "file.txt"), "version worktree\n");
    git("-C", worktree, "add", "file.txt");
    git("-C", worktree, "commit", "-qm", "worktree rewrites file");
    // El destino tenía una modificación staged del MISMO archivo
    fs.writeFileSync(path.join(tempRepo, "file.txt"), "version destino staged\n");
    git("add", "file.txt");
    const stampPath = path.join(tempRepo, ".flowtask", "config", ".review-stamp");
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, JSON.stringify({ ts: "2026-08-25T20:00:00Z", branch: "main" }));
    const stampBefore = fs.readFileSync(stampPath, "utf8");
    const stampMtimeBefore = fs.statSync(stampPath).mtimeMs;

    const result = runResultWithEnv(
      {},
      "complete", "CA-tx-conflict", "--base", "main", "--preserve-dirty"
    );

    assert.equal(result.status, 1);
    // Fusión conservada (HEAD avanzó con la versión del worktree)
    assert.equal(fs.readFileSync(path.join(tempRepo, "file.txt"), "utf8"), "version worktree\n");
    // Backup intacto
    assert.ok(backupRefs().length > 0);
    const txId = fs.readdirSync(backupsDir())[0];
    assert.equal(
      fs.readFileSync(path.join(backupsDir(), txId, "journal"), "utf8"),
      "pending_manual\n"
    );
    // Instrucciones seguras: plantillas fijas + tx-id, SIN paths del repo
    assert.match(result.stderr, new RegExp(txId));
    assert.match(result.stderr, /pendiente-manual/);
    assert.ok(!result.stderr.includes("file.txt"), "el mensaje filtra un path del repo");
    // AC2.8: sello inalterado también en pending_manual
    assert.equal(fs.readFileSync(stampPath, "utf8"), stampBefore);
    assert.equal(fs.statSync(stampPath).mtimeMs, stampMtimeBefore);
  });

  // AC2.8 — sello de validación inalterado en happy path
  it("leaves the review stamp content and mtime untouched on success", () => {
    createCommittedWorktree("CA-tx-stamp");
    createMixedDirtyDestination("stamp");
    const stampPath = path.join(tempRepo, ".flowtask", "config", ".review-stamp");
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, JSON.stringify({ ts: "2026-08-25T20:00:00Z", branch: "main" }));
    const stampBefore = fs.readFileSync(stampPath, "utf8");
    const stampMtimeBefore = fs.statSync(stampPath).mtimeMs;

    const result = runResult("complete", "CA-tx-stamp", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(stampPath, "utf8"), stampBefore);
    assert.equal(fs.statSync(stampPath).mtimeMs, stampMtimeBefore);
  });
});
