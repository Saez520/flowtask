# Persona, autonomy, and permissions layers

## Purpose

FlowTask separates into three layers, stored and evaluated separately, what the
runner **says**, what the runner **does without asking**, and what the runner
**is technically allowed to do**. Each layer has its own contract,
its own file, and its own failure mode.

The separation prevents a tone change from expanding initiative or limits, and
prevents an initiative change from expanding limits. Precedence between layers is
structural and does not depend on the case: `permissions > autonomy > persona`.

## Layers

| Layer | Question it answers | File | Effect |
|------|-----------------------|---------|--------|
| Persona | How does it speak and how much does it explain? | `profile.json` | Tone and depth of the conversation. |
| Autonomy | What does it do without asking? | `autonomy.json` | Initiative: whether it starts work on its own or waits for the order. |
| Permissions | What is technically allowed? | `permissions.json` | Technical envelope: which tools and actions it can execute. |

No layer authorizes on its own. Persona does not authorize or restrict: it only
defines tone. Autonomy declares initiative and does not expand the technical
envelope. The permissions envelope is the only limit that bounds action.

## Values and schema

**Persona.** `profile.json` keeps its current shape: `{level, persona,
onboarded}`. Valid levels are `training`, `mid`, `senior`, and `custom`. The
legacy `junior` level is accepted only as a read alias and is normalized to
`training`; no new write emits it.

**Autonomy.** `autonomy.json` is a new and separate layer, with an explicit
schema version:

```json
{ "version": 1, "profile": "assistant" }
```

The values of `profile` are exactly two:

| Value | Semantics |
|-------|-----------|
| `assistant` | Does not start autonomous execution: waits for an explicit order per job. |
| `autonomous-dev` | Runs the full loop under gates, audit, validation, and permissions. |

**Permissions.** `permissions.json` is a new and separate layer:

```json
{ "version": 1, "envelope": "standard" }
```

`standard` is the only technical envelope in this phase and is equivalent to the current
technical gate: it adds no capability.

## Per-layer resolution

There are two logical sources: `team` (base) and `project` (override). Resolution
is done **per layer** and with **full replacement**:

- If the project defines the layer, the project governs entirely.
- If the project does not define it, the team base applies.
- If neither defines it, the layer is absent.

There is no field mixing between sources: a layer resolves completely or does not resolve.
An invalid project layer **does not** fall back to the team base: it is invalid, and
that is a failure.

Once resolved, layer precedence is:

```
permissions > autonomy > persona
```

## Precedence

For any decision, the order is structural:

1. **Permissions** define the technical limit. It is the only layer that can prevent an
   action.
2. **Autonomy** defines initiative within that limit. It can only
   restrict; it never expands the permissions envelope.
3. **Persona** defines tone. It does not participate in any authorization.

Observable consequences:

- An action suggested by autonomy and outside the permissions envelope is denied.
- A persona change does not alter what is done without asking or what is
  allowed.
- An autonomy change does not alter the permissions envelope.

## Per-layer failure

| Missing or invalid layer | Behavior | Result |
|--------------------------|----------------|-----------|
| Permissions | Operational failure with message | No action with expanded limits is executed. |
| Autonomy | Operational failure with message | No execution starts. |
| Persona | Visible warning and continuation | Continues without persona injection, with autonomy and permissions intact. |

The operational failure of permissions or autonomy has no default value: it does not
continue with an invented value or expanded limits. Persona failure
does not repair anything either: it does not invent a tone and does not alter the other layers.

## Enforcement points

| Point | What it verifies | Scope |
|-------|---------------|---------|
| Runner injection | The resolved autonomy value is injected into the runner agent between its markers. | Runner only. |
| Permissions gate | Before applying the technical allowlist, the gate validates that the autonomy and permissions layers exist and are valid in the target. | Runner tools only. |

The gate **does not read autonomy to authorize tools**: autonomy does not
authorize. If the permissions or autonomy layer is missing or invalid, the gate
denies with its operational message. Agents other than the runner are not subject
to this check, and the universal commit gate keeps its behavior.

## Migration

Existing installations keep working. `install` and `update` create the new
layers **only when the layer does not exist**:

| Missing layer | File created | Content |
|--------------|----------------|---------|
| Autonomy | `autonomy.json` | `{ "version": 1, "profile": "assistant" }` |
| Permissions | `permissions.json` | `{ "version": 1, "envelope": "standard" }` |

The autonomy migration default is the lowest initiative: the installed system
waits for an explicit order per job. An explicit choice, given with
`--autonomy` or through the single interactive question, is stored as
`assistant` or `autonomous-dev`. The migration default is a migration, **not** a
runtime fallback: at runtime, a missing or invalid layer is a failure.

An invalid layer is never repaired with a default: the operation fails and the
file is preserved as it was. A valid layer is preserved, and `--autonomy`
overwrites it only when the developer chooses a different value. The interactive
answer applies to absent layers only. A persona change preserves its file and
does not touch the autonomy and permissions layers.

Layer files live next to `profile.json` in the target's configuration
directory and are ignored in git: they are local state, not versioned content.
The definitive path for the team base and the project registry is defined by the per-team
installation and per-project registry phases; the layer resolver receives logical
sources and does not fix that path.

## Boundary with the domain policy

This phase defines **only the enforcement mechanism** of the technical envelope. The
capability policy and its domain permissions belong to a later phase and are not
implemented here.

Consequently, autonomy declares initiative, but without the capability policy and
without domain permissions it does not expand the technical envelope: the current
technical gate remains the limit.

## Verification

~~~
node --test .flowtask/bin/test/capas-contrato.test.js
node --test .flowtask/bin/test/layers.test.js
node --test .flowtask/bin/test/layers-cli.test.js
node --test .flowtask/bin/test/runner-autonomy-injection.test.js
node --test .flowtask/bin/test/permission-gate-layers.test.js
~~~

The normative source of the policy-based autonomy contract is
[operational-autonomy.md](./operational-autonomy.md), and the technical gate's is
[../permission-gate.md](../permission-gate.md).
