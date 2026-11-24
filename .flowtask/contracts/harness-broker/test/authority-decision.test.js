import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProfileYaml, readAuthorityContract, validateProfile } from "../lib/authority.js";
import { answerPending, decide, outcomeOf } from "../lib/authority-decision.js";
import { getValidator } from "../lib/schemas.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORITY = join(ROOT, "examples", "authority", "valid");

const loadProfile = (name) =>
  parseProfileYaml(readFileSync(join(AUTHORITY, `authority-profile.${name}.yaml`), "utf8")).document;

const STANDARD = loadProfile("standard");
const READ_ONLY = loadProfile("read-only");
const ASK_PARENT = loadProfile("ask-parent");
const CONTEXT = { run_cwd: "/work/run", home: "/home/u" };
const CONTRACT = readAuthorityContract();

const write = (path, context = CONTEXT) =>
  decide(STANDARD, { category: "filesystem", operation: "write", path }, context);
const shell = (command, profile = STANDARD) => decide(profile, { category: "shell", command }, CONTEXT);

const ARTIFICIAL_HARNESS_PERMITTING = {
  ...STANDARD,
  shell: { allow: ["opencode run *", "claude -p *", "opencode run x", "git status"], deny: [] }
};

describe("filesystem decisions", () => {
  it("allows a write inside the writable root", () => {
    assert.deepEqual(write("/work/run/src/a.js"), {
      decision: "allow",
      rule: "filesystem.writable_roots[0]",
      reason: "allowed_by_rule"
    });
  });

  it("denies a write outside the root as uncovered", () => {
    assert.deepEqual(write("/etc/hosts"), { decision: "deny", rule: null, reason: "uncovered" });
  });

  it("denies a write inside the root that the denylist names, with the rule index", () => {
    assert.deepEqual(write("/work/run/.flowtask/config/x"), {
      decision: "deny",
      rule: "filesystem.deny[3]",
      reason: "denied_by_rule"
    });
  });

  it("denies a case variant of a denylisted path, while allow decisions stay case sensitive", () => {
    const upper = { run_cwd: "/repo/.worktrees/run", home: "/home/u" };
    assert.deepEqual(write("/repo/.worktrees/run/.FLOWTASK/config/x", upper), {
      decision: "deny",
      rule: "filesystem.deny[3]",
      reason: "denied_by_rule"
    });
    assert.equal(write("/repo/.worktrees/run/src/a.js", upper).decision, "allow");
    assert.deepEqual(write("/repo/.worktrees/RUN/src/a.js", upper), { decision: "deny", rule: null, reason: "uncovered" });
  });

  it("expands the home placeholder before comparing the denylist", () => {
    assert.deepEqual(decide(STANDARD, { category: "filesystem", operation: "read", path: "/home/u/.ssh/id" }, CONTEXT), {
      decision: "deny",
      rule: "filesystem.deny[0]",
      reason: "denied_by_rule"
    });
  });

  it("denies a path that climbs out with parent segments", () => {
    assert.equal(write("/work/run/../../etc/passwd").reason, "path_not_canonical");
    assert.equal(write("/work/run/../../etc/passwd").decision, "deny");
  });

  it("denies a path that ends with a separator as not canonical", () => {
    assert.equal(write("/work/run/").reason, "path_not_canonical");
  });

  it("allows a read under a readable root and names the root", () => {
    assert.deepEqual(decide(STANDARD, { category: "filesystem", operation: "read", path: "/usr/lib/x" }, CONTEXT), {
      decision: "allow",
      rule: "filesystem.readable_roots[1]",
      reason: "allowed_by_rule"
    });
  });

  it("denies every write under the read-only profile", () => {
    const verdict = decide(READ_ONLY, { category: "filesystem", operation: "write", path: "/work/run/a" }, CONTEXT);
    assert.equal(verdict.decision, "deny");
    assert.equal(verdict.reason, "uncovered");
  });

  it("lets a protected path win even inside the writable root", () => {
    const verdict = write("/work/run/a", { ...CONTEXT, protected_paths: ["/work/run/a"] });
    assert.deepEqual(verdict, { decision: "deny", rule: "contract.implicit_denial", reason: "protected_path" });
  });

  it("denies a main repository outside the run working directory and allows it inside", () => {
    const outside = write("/repo/main/x", { ...CONTEXT, main_repository: "/repo/main" });
    assert.equal(outside.reason, "protected_path");
    const inside = write("/work/run/sub/x", { ...CONTEXT, main_repository: "/work/run/sub" });
    assert.equal(inside.decision, "allow");
  });

  it("asks the parent for an uncovered write when the policy says so, and still denies explicit denials", () => {
    const asking = { ...STANDARD, on_uncovered: { ...STANDARD.on_uncovered, filesystem: "ask_parent" } };
    assert.deepEqual(decide(asking, { category: "filesystem", operation: "write", path: "/etc/hosts" }, CONTEXT), {
      decision: "ask_parent",
      rule: null,
      reason: "uncovered"
    });
    assert.equal(decide(asking, { category: "filesystem", operation: "write", path: "/work/run/.flowtask/config/x" }, CONTEXT).decision, "deny");
  });

  it("rejects an unknown operation with a TypeError", () => {
    assert.throws(() => decide(STANDARD, { category: "filesystem", operation: "exec", path: "/work/run/a" }, CONTEXT), TypeError);
  });
});

describe("shell decisions", () => {
  it("allows a command the profile lists and names the entry", () => {
    assert.deepEqual(shell("git status"), { decision: "allow", rule: "shell.allow[0]", reason: "allowed_by_rule", segments: [
      { command: "git status", decision: "allow", rule: "shell.allow[0]", reason: "allowed_by_rule" }
    ] });
  });

  it("denies an uncovered command", () => {
    assert.equal(shell("curl http://x").decision, "deny");
    assert.equal(shell("curl http://x").reason, "uncovered");
  });

  it("denies a compound as a whole when one segment is not authorised, and reports every segment", () => {
    const verdict = shell("git status && curl x");
    assert.equal(verdict.decision, "deny");
    assert.deepEqual(verdict.segments.map((segment) => segment.decision), ["allow", "deny"]);
  });

  it("allows a compound whose segments are all authorised", () => {
    assert.equal(shell("git status ; git status").decision, "allow");
  });

  it("keeps a separator inside double quotes within a single segment", () => {
    const verdict = shell('echo "a;b"');
    assert.equal(verdict.segments.length, 1);
    assert.equal(verdict.segments[0].command, 'echo "a;b"');
  });

  it("denies a command that a deny entry names, with the rule index", () => {
    assert.deepEqual(shell("git push origin main"), {
      decision: "deny",
      rule: "shell.deny[0]",
      reason: "denied_by_rule",
      segments: [{ command: "git push origin main", decision: "deny", rule: "shell.deny[0]", reason: "denied_by_rule" }]
    });
  });

  it("treats redirection, substitution, eval and inline interpreter scripts as ambiguous", () => {
    for (const command of ["git status > out", "`whoami`", "$(whoami)", "eval x", 'bash -c "x"', "sh -lc x"]) {
      const verdict = shell(command);
      assert.equal(verdict.decision, "deny", command);
      assert.equal(verdict.reason, "ambiguous_syntax", command);
      assert.equal(verdict.rule, null, command);
    }
  });

  it("treats an unclosed quote and an empty segment as ambiguous", () => {
    assert.equal(shell('echo "abc').reason, "ambiguous_syntax");
    assert.equal(shell("git status;").reason, "ambiguous_syntax");
  });

  it("asks the parent for an uncovered command under the ask-parent profile, but denies a denied one", () => {
    assert.equal(shell("curl x", ASK_PARENT).decision, "ask_parent");
    assert.equal(shell("git push x", ASK_PARENT).decision, "deny");
  });
});

describe("direct harness invocation", () => {
  const INVOCATIONS = [
    "opencode run x",
    "claude -p x",
    "env A=1 npx opencode run x",
    "/usr/local/bin/claude -p x",
    "sudo -u u claude",
    "timeout 5 opencode run x",
    "git status && opencode run x",
    '"opencode" run x',
    "A='x y' claude -p z",
    'A="x y" opencode run',
    "A='x y' env claude",
    "$'claude' -p",
    "$'\\x63laude' -p",
    "cl''aude -p z",
    "claude\\ -p"
  ];

  for (const command of INVOCATIONS) {
    it(`denies "${command}" under standard, ask-parent and a profile that lists it`, () => {
      for (const profile of [STANDARD, ASK_PARENT, ARTIFICIAL_HARNESS_PERMITTING]) {
        const verdict = shell(command, profile);
        assert.equal(verdict.decision, "deny", command);
        assert.equal(verdict.rule, "contract.direct_harness_denial", command);
        assert.equal(verdict.reason, "direct_harness_invocation", command);
      }
    });
  }

  it("does not treat a command whose name only starts like a harness as a harness", () => {
    assert.equal(shell("opencodefoo x").reason, "uncovered");
    assert.equal(shell("claudex x").reason, "uncovered");
  });

  it("refuses to list a harness executable in shell.allow when the profile is validated", () => {
    const document = structuredClone(STANDARD);
    document.shell.allow = ['"opencode" run *'];
    const verdict = validateProfile(document);
    assert.deepEqual(verdict.fields, [{ field: "shell.allow.0", problem: "direct_harness_not_allowed" }]);
  });

  it("denies a harness name that a quoted assignment value hides from the word split", () => {
    const verdict = shell("A='x y' claude -p z", ASK_PARENT);
    assert.equal(verdict.decision, "deny");
    assert.equal(verdict.reason, "direct_harness_invocation");
  });

  it("denies a harness name written with ANSI-C or concatenated quoting", () => {
    for (const command of ["$'claude' -p", "$'\\x63laude' -p", "cl''aude -p z"]) {
      assert.equal(shell(command).reason, "direct_harness_invocation", command);
    }
  });

  it("denies a harness name written in locale-translated double quotes", () => {
    for (const command of ['$"claude" -p z', '$"opencode" run x']) {
      assert.equal(shell(command, ASK_PARENT).reason, "direct_harness_invocation", command);
    }
  });

  it("denies a harness name whatever its letter case or executable suffix", () => {
    const commands = [
      "CLAUDE -p z",
      "Claude -p z",
      "./CLAUDE -p z",
      "OPENCODE run x",
      "CL''AUDE -p z",
      "/USR/BIN/CLAUDE -p z",
      "claude.exe -p z",
      "Claude.CMD -p z"
    ];
    for (const command of commands) {
      assert.equal(shell(command, ASK_PARENT).reason, "direct_harness_invocation", command);
    }
  });

  it("denies a harness name in upper case under a profile that allows an assignment prefix", () => {
    const permissive = { ...STANDARD, shell: { allow: ["A=* *"], deny: [] } };
    assert.equal(shell("A=1 CLAUDE -p z", permissive).decision, "deny");
  });

  it("denies a harness name carried by a wrapper option or by an attached argument", () => {
    const commands = [
      "env -Sclaude -p z",
      'env -S"claude -p" z',
      "env --split-string=claude",
      'env --split-string="claude -p"',
      "env -S 'claude -p x'"
    ];
    for (const command of commands) {
      assert.equal(shell(command, ASK_PARENT).reason, "direct_harness_invocation", command);
    }
  });

  it("denies a dynamic executable word as ambiguous syntax", () => {
    const commands = [
      "$C -p x",
      "C=claude;$C -p x",
      '"$C" -p',
      "$0 -p",
      "$a$b -p",
      "cl*ude -p",
      "[c]laude -p",
      "C=claude;$C",
      'timeout 5 node --test "$f"'
    ];
    for (const command of commands) {
      const verdict = shell(command, ASK_PARENT);
      assert.equal(verdict.decision, "deny", command);
      assert.equal(verdict.reason, "ambiguous_syntax", command);
    }
  });

  it("denies a harness name after a wrapper whatever comes before it", () => {
    for (const command of ["env $X claude -p z", "nice -n $x claude", "timeout 5 claude -p z"]) {
      assert.equal(shell(command, ASK_PARENT).decision, "deny", command);
    }
  });

  it("lists the always denied executables from the contract", () => {
    assert.deepEqual(CONTRACT.always_denied_executables, ["opencode", "claude"]);
  });
});

describe("network decisions", () => {
  const net = (profile, host, port = 443) => decide(profile, { category: "network", host, port }, CONTEXT);

  it("allows nothing when the profile has no destinations", () => {
    assert.deepEqual(net(READ_ONLY, "registry.npmjs.org"), { decision: "deny", rule: null, reason: "uncovered" });
  });

  it("allows only a listed destination on its port", () => {
    assert.deepEqual(net(STANDARD, "registry.npmjs.org"), {
      decision: "allow",
      rule: "network.allow[0]",
      reason: "allowed_by_rule"
    });
    assert.equal(net(STANDARD, "registry.npmjs.org", 8080).decision, "deny");
    assert.equal(net(STANDARD, "evil.npmjs.org").decision, "deny");
  });

  it("denies numeric destinations whatever the profile lists", () => {
    for (const host of ["10.0.0.1", "[::1]", "2130706433"]) {
      assert.equal(net(STANDARD, host).reason, "numeric_destination", host);
    }
  });

  it("denies alternative numeric spellings even when uncovered destinations are asked of the parent", () => {
    assert.equal(ASK_PARENT.on_uncovered.network, "ask_parent");
    for (const host of ["127.1", "0x7f.1", "0177.0.0.1", "0x7f000001", "2130706433", "10.0.0.1", "[::1]"]) {
      assert.deepEqual(net(ASK_PARENT, host), { decision: "deny", rule: null, reason: "numeric_destination" }, host);
    }
  });

  it("matches a wildcard entry for subdomains and not for the apex", () => {
    const wildcard = { ...STANDARD, network: { allow: ["*.example.com"] } };
    assert.equal(net(wildcard, "a.example.com").decision, "allow");
    assert.equal(net(wildcard, "a.b.example.com").decision, "allow");
    assert.equal(net(wildcard, "example.com").decision, "deny");
  });

  it("normalises case and a trailing dot", () => {
    assert.equal(net(STANDARD, "REGISTRY.npmjs.org.").decision, "allow");
  });

  it("rejects a port out of range with a TypeError", () => {
    assert.throws(() => net(STANDARD, "registry.npmjs.org", 0), TypeError);
    assert.throws(() => net(STANDARD, "registry.npmjs.org", 70000), TypeError);
  });
});

describe("tools decisions", () => {
  it("allows a listed native tool and denies an unlisted one", () => {
    assert.deepEqual(decide(STANDARD, { category: "tools", tool: "read" }, CONTEXT), {
      decision: "allow",
      rule: "tools.allow[0]",
      reason: "allowed_by_rule"
    });
    assert.equal(decide(STANDARD, { category: "tools", tool: "bash" }, CONTEXT).decision, "deny");
  });

  it("lets a deny entry win over an allow entry for the same tool", () => {
    const both = { ...STANDARD, tools: { ...STANDARD.tools, allow: ["read"], deny: ["read"] } };
    assert.deepEqual(decide(both, { category: "tools", tool: "read" }, CONTEXT), {
      decision: "deny",
      rule: "tools.deny[0]",
      reason: "denied_by_rule"
    });
  });

  it("allows every tool of a listed MCP server and nothing of another server", () => {
    assert.deepEqual(decide(STANDARD, { category: "tools", mcp: { server: "docs-server", tool: "mem_save" } }, CONTEXT), {
      decision: "allow",
      rule: "tools.mcp_allow[0]",
      reason: "allowed_by_rule"
    });
    assert.equal(decide(STANDARD, { category: "tools", mcp: { server: "other", tool: "mem_save" } }, CONTEXT).decision, "deny");
  });

  it("rejects a tool action that names neither a tool nor an MCP pair", () => {
    assert.throws(() => decide(STANDARD, { category: "tools" }, CONTEXT), TypeError);
  });
});

describe("uncovered policy", () => {
  it("denies every uncovered request under the default policy", () => {
    for (const category of CONTRACT.categories) {
      assert.equal(STANDARD.on_uncovered[category], CONTRACT.default_uncovered_policy, category);
    }
  });

  it("keeps a denial by rule even when the category asks the parent", () => {
    assert.equal(shell("git push x", ASK_PARENT).decision, "deny");
    assert.equal(shell("curl x", ASK_PARENT).decision, "ask_parent");
  });
});

describe("authority is independent of autonomy", () => {
  it("produces identical decisions under both autonomy profiles and without the key", () => {
    const actions = [
      { category: "filesystem", operation: "write", path: "/work/run/a" },
      { category: "filesystem", operation: "write", path: "/etc/hosts" },
      { category: "shell", command: "git status" },
      { category: "shell", command: "curl x" },
      { category: "network", host: "registry.npmjs.org", port: 443 },
      { category: "tools", tool: "read" }
    ];
    const outcomes = [{ autonomy: "assistant" }, { autonomy: "autonomous-dev" }, {}].map((extra) =>
      actions.map((action) => decide(STANDARD, action, { ...CONTEXT, ...extra }))
    );
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.deepEqual(outcomes[0], outcomes[2]);
  });
});

describe("permission outcomes", () => {
  it("answers an allow without consulting the parent", () => {
    const outcome = outcomeOf({ decision: "allow" });
    assert.deepEqual(outcome, {
      answer: { option_kind: "allow_once", decided_by: "authority_policy" },
      counts: "granted"
    });
    assert.equal("pause" in outcome, false);
  });

  it("answers a deny with reject_once, one rejected request and a failed run", () => {
    assert.deepEqual(outcomeOf({ decision: "deny" }), {
      answer: { option_kind: "reject_once", decided_by: "authority_policy" },
      counts: "rejected",
      run_ends: { state: "failed", reason: "permission_rejected" }
    });
  });

  it("pauses an ask_parent with permission_pending", () => {
    assert.deepEqual(outcomeOf({ decision: "ask_parent" }), {
      pause: { state: "input_required", cause: "permission_pending" }
    });
  });

  it("rejects a decision that is not a decision of decide", () => {
    assert.throws(() => outcomeOf({}), TypeError);
  });

  it("builds a permission_resolved event that validates against the event schema", () => {
    const answer = answerPending({ decision: "ask_parent" }, "allow_once").answer;
    const event = {
      run_id: "run-0001",
      cursor: 3,
      timestamp: "2026-11-23T20:00:02Z",
      type: "permission_resolved",
      payload: {
        request_id: "req-1",
        option_id: "allow-once",
        option_kind: answer.option_kind,
        decided_by: answer.decided_by
      }
    };
    const validate = getValidator("event");
    assert.equal(validate(event), true, JSON.stringify(validate.errors));
  });
});

describe("parent answers", () => {
  const ask = { decision: "ask_parent" };

  it("never grants what the decision did not ask about", () => {
    assert.deepEqual(answerPending({ decision: "deny" }, "allow_once"), { ok: false, reason: "not_consultable" });
    assert.deepEqual(answerPending({ decision: "allow" }, "allow_always"), { ok: false, reason: "not_consultable" });
  });

  it("treats an always grant as a single grant that is not persisted", () => {
    assert.deepEqual(answerPending(ask, "allow_always"), {
      ok: true,
      answer: { option_kind: "allow_once", decided_by: "parent" },
      persisted: false,
      run_ends: null
    });
  });

  it("ends the run with permission_rejected when the parent rejects", () => {
    assert.deepEqual(answerPending(ask, "reject_once"), {
      ok: true,
      answer: { option_kind: "reject_once", decided_by: "parent" },
      persisted: false,
      run_ends: { state: "failed", reason: "permission_rejected" }
    });
  });

  it("refuses a missing or unknown option, so silence never grants", () => {
    assert.throws(() => answerPending(ask, undefined), TypeError);
    assert.throws(() => answerPending(ask, "yes"), TypeError);
  });
});

describe("decision module boundaries", () => {
  it("rejects an action with an unknown category", () => {
    assert.throws(() => decide(STANDARD, { category: "process" }, CONTEXT), TypeError);
  });

  it("does not import filesystem, process or network modules", () => {
    const source = readFileSync(join(ROOT, "lib", "authority-decision.js"), "utf8");
    assert.doesNotMatch(source, /node:(fs|child_process|net|http|https|dgram|tls|dns)/);
  });
});
