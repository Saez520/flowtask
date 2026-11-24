# Harness broker contract

This package is the executable contract for delegating work to another agent harness. It defines the messages, the run lifecycle, the adapter interface and the conformance suite that every implementation must pass. It does not contain a broker: launching, supervising and recording runs is implemented elsewhere and must satisfy this contract.

The contract is independent of the language of the broker and of the harness it drives.

## Layout

```
README.md                 this document
package.json              package manifest; the dependencies are the JSON Schema validator and its formats, and the YAML parser used by the reference model
state-machine.v1.json    run lifecycle as data: states, transitions, pause causes, failure reasons, clocks, cancellation policy
adapter-interface.v1.json operations every adapter implements, the behaviours each must exhibit, stop reason mapping
authority-contract.v1.json data of the authority profile: closed vocabularies, resolution order, placeholders, command conventions
schemas/v1/              JSON Schemas (draft 2020-12) of every message, of the data files and of the authority profile document
examples/                valid and invalid documents, indexed by examples/manifest.json
examples/authority/      authority profile documents in YAML, indexed by examples/authority/manifest.json
lib/schemas.js           loads the schemas into a strict validator
lib/reference-model.js   pure functions: transition checks, event log invariants, cursor reads, cancellation policy, stop reason mapping
lib/authority.js         authority profile documents: YAML parsing, validation, fingerprint, resolution by layer, path and command matching
lib/authority-decision.js pure decisions for filesystem, shell, network and tool requests, permission outcomes and the terminal log
conformance/cases.v1.json catalogue of conformance cases
conformance/scenario.schema.json  schema of the simulated child programs
conformance/scenarios/   simulated child programs, one per behaviour
conformance/fake-child/  simulated child that speaks the agent protocol over standard streams
test/                    the conformance suite
```

## Running the suite

```
npm install
npm test
```

`npm install` is the only step that uses the network; it also installs the YAML parser used by the authority profile model. The suite itself needs no network access and no harness. Cases that need a running broker, a real adapter, a real harness or the permission gate are listed in the report as skipped, each with its reason. A skipped case is never a pass.

## Core operations

The core exposes these operations. Their request and response shapes are the schemas in `schemas/v1`.

- `delegate`: accepts a delegation request and returns the run identifier in the `submitted` state, without waiting for the child. An invalid request returns a validation error that names each invalid field and creates no run.
- `status`: returns the current state of a run, the pause in progress, the limits running now with their remaining time, and the last observed activity.
- `result`: returns the normalized result of a terminal run. For a run that is not terminal it returns the current state and no partial result.
- `cancel`: requests cancellation. It is idempotent: a terminal run is returned unchanged, and a cancellation reaches the child only while its turn is live.
- read events: returns the events of a run after a cursor, in order, with the next cursor and the last cursor. Reading from the last cursor returns an empty page with the same cursor.
- `respond_permission`: answers a permission request of a run paused in `input_required` with the `permission_pending` cause.

## States

| State | Terminal | Meaning |
|---|---|---|
| `submitted` | no | Accepted, not yet started. |
| `working` | no | The child is running a turn. |
| `input_required` | no | Paused for input; the cause is `permission_pending` or `authority_block`. |
| `auth_required` | no | Paused for authentication or balance; the cause is `auth` or `balance`. |
| `completed` | yes | The turn closed with `end_turn`. |
| `failed` | yes | Ended with one of the closed failure reasons. |
| `canceled` | yes | Cancelled on request; the result names who asked. |
| `rejected` | yes | Denied by the authority gate before any process started. |

The transitions allowed out of each state are listed in `state-machine.v1.json`. Any other transition is forbidden, and a terminal state has no outgoing transition.

Failure reasons are a closed list: `no_first_event`, `idle_timeout`, `wall_timeout`, `exit_nonzero`, `exit_without_result`, `permission_rejected`, `refusal`, `max_tokens`, `max_turn_requests`, `launch_failed`, `supervisor_lost`.

Clocks: the first-event clock runs from `working` until the first valid event; the inactivity clock runs after the first event and is suspended in pauses; the wall clock runs from `working` until the run is terminal, pauses included. The meaning of each clock is in `clock_descriptions` of `state-machine.v1.json`.

## Authority profile

An authority profile is a YAML document that states what a delegated child may do: the filesystem, the shell commands, the network destinations and the tools it may use, and what happens to a request that no rule covers. Its structure is defined by `schemas/v1/authority-profile.schema.json`; the closed vocabularies, the resolution order and the conventions shared by every enforcement layer are the data in `authority-contract.v1.json`.

**Document.** The top-level fields are `version` (must be `1`), `name`, `description`, `filesystem`, `shell`, `network`, `tools` and `on_uncovered`. Every section is required and unknown fields are rejected. Nothing is completed with a default: a document that omits a section is invalid. The YAML is read as YAML 1.2 core, with one document, unique keys, and no anchors, aliases or custom tags. A document written in JSON with the same content is the same profile.

**Location and resolution.** A profile is a file named `authority-profile.<name>.yaml`, in `.flowtask/config/` for the project and in `~/.config/flowtask/config/` for the user. The team source is located by the same mechanism as the other layers of the team source. A profile is resolved in the order project, user, team. The first source that defines it governs it as a whole: fields are never merged across sources, and an invalid profile is reported as invalid instead of being replaced by a lower source.

**Filesystem.** At most one writable root; an empty list makes the child read-only. Readable roots are additional to the writable root, which is always readable. The denylist prevails over every permission, for reads and writes. The placeholders `${run_cwd}` (the absolute working directory of the request) and `${home}` are accepted only at the start of a path and are expanded before any comparison. A path pattern covers the path itself and everything below it; `*` matches one path segment, `**` matches any text including separators, and `?` matches one character other than a separator. The enforcement layer supplies the paths already resolved, so symbolic links are resolved there, and the protected paths and the main repository outside the run working directory are denied even when the profile does not list them. A parent segment or a path that ends with a separator is not canonical and is denied. The denylist and the protected paths are compared without regard to case, so a case variant of a denied path is denied; allow decisions remain case sensitive. Whether the paths the enforcement layer supplies are already canonical on case-insensitive file systems is not verified for macOS [No verificado].

**Shell.** A command line is split on unquoted `;`, `&&`, `||`, `|` and `&`. Each segment is matched as a whole against the patterns, where `*` matches any text and `?` one character. Ambiguous syntax is always denied: redirections, command and process substitutions, subshells, braces, backticks, `eval`, inline interpreter scripts, unclosed quotes and empty segments. A compound is denied as a whole when any segment is not authorised, and no segment of a denied compound is executed. A direct invocation of a harness executable (`opencode`, `claude`) is always denied, under every profile, including a profile that lists it; the command wrappers `env`, `npx`, `sudo`, `timeout` and similar are looked through, and a harness name that appears after a wrapper is denied as well. Words are read after removing quotes, ANSI-C escapes and backslashes, and a segment that has a harness name as any of its words is denied, whether or not a wrapper precedes it.

**Network.** A destination is a host name with an optional `*.` prefix and an optional port; the port defaults to 443. IP addresses, numeric hosts and `localhost` are not valid destinations, and a numeric destination in a request is denied. Alternative numeric spellings, such as `127.1`, `0x7f.1`, `0177.0.0.1` and `0x7f000001`, are numeric destinations too, and are denied whatever the `on_uncovered` policy for the network. An empty list means the child has no network.

**Tools.** Native tools are named; MCP tools are named by server and tool, and the tool `*` stands for every tool of that server. A deny entry prevails over an allow entry. A tool whose effect is a shell command, a write or a network connection stays subject to the shell, filesystem and network rules: permitting the tool does not lift them.

**Uncovered requests.** Each category of `on_uncovered` is `deny` or `ask_parent`. A request that a rule denies explicitly is denied under either policy. A request under `ask_parent` pauses the run with the cause `permission_pending`; the parent may allow or reject it, but cannot grant what is denied. An "always" grant is treated as a single grant and is not kept beyond the run. Silence grants nothing.

**Outcomes.** A covered request is granted by the authority policy without asking the parent. A denied request answers `reject_once`, counts as one rejected request, and ends the run as `failed` with the reason `permission_rejected`, because a rejection aborts the turn.

**Reflection.** A result carries `authority`, with the profile name and fingerprint and the denials made by the enforcement layer in `os_denials`. A transition into `working` carries `authority_profile`. A diagnostic line that reports a denial carries `authority_denial`. Such a denial is not a permission request and is not counted in `permissions`. The terminal log is JSON Lines, one line per attempt, allowed or denied; an environment value is recorded as `NAME=<redacted>`, `rule` is `null` when no rule covered the attempt, and `exit_code` is `null` unless the command ran.

**Fingerprint.** The fingerprint is the SHA-256 digest, in lowercase hexadecimal, of the canonical JSON of the validated document: object keys sorted, no whitespace, arrays in their order. The same profile written with another key order or another YAML layout has the same fingerprint.

**Two layers.** The profile is a declaration. An adapter declares in `enforcement` which rules it can make effective: `filesystem`, `shell`, `network`, `tools` and `direct_harness_denial`. A run whose profile needs a rule the adapter does not declare is refused before any process starts, and the refusal names the rule. This package does not describe how each harness enforces the rules.

**Limits of the reference model.** The shell analysis is lexical. A child may build a harness invocation through an interpreter of another language that the analysis does not see; the operating system layer is the second line of defence. Delegation is refused when the permissions or autonomy layer is missing or invalid, and when assistant autonomy is used without an explicit order from the operator.

## Naming in the data

Data files and JSON properties use `snake_case`. The reference model returns JavaScript objects in `camelCase`: `cancelPolicy` returns `sendToChild`, which corresponds to the `send_to_child` property of the state machine data.

## Versioning

Every document carries `schema_version`, which is `1` for this version. Adding a state, a transition, a failure reason or an event type requires publishing a new major version, `schemas/v2`, and a new data file. Version 1 documents are never changed in a way that alters their meaning. Adding an optional property to an existing message, as the authority fields do, does not require a new major version; producers that do not use authority omit it.

## Adding an adapter

An adapter for a harness implements the operations of `adapter-interface.v1.json`, declares its capabilities as described by `schemas/v1/adapter-capabilities.schema.json`, and maps the native stop reasons with the mapping of the same file. To be conformant it must:

1. pass every case of the catalogue that applies to its declared capabilities;
2. have no skipped case of the contract level, and no skipped case of the harness level when its declared capabilities require it.

A case that cannot run must stay listed and skipped with its reason. Adding a new case means adding its id, its criteria, its scenario when it uses one, and its check to `conformance/cases.v1.json`, and the suite rejects a case whose referenced files do not exist.

## Not covered

This contract does not define:

- how the authority policy is enforced in each harness, the operating system sandbox that produces the terminal log and the denials, and the engine that applies the profile; this package defines the profile document, its validation, its resolution, the reference decisions and how they are reflected;
- the default values of the time limits and of the cancellation grace period, which are configuration of the broker;
- the storage of runs, the command line interface and the protocol server that expose the operations;
- resumption of sessions, idempotency keys for `delegate`, and a streaming subscription to events;
- the behaviour of Windows process groups, which the contract does not verify.
