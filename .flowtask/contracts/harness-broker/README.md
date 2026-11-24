# Harness broker contract

This package is the executable contract for delegating work to another agent harness. It defines the messages, the run lifecycle, the adapter interface and the conformance suite that every implementation must pass. It does not contain a broker: launching, supervising and recording runs is implemented elsewhere and must satisfy this contract.

The contract is independent of the language of the broker and of the harness it drives.

## Layout

```
README.md                 this document
package.json              package manifest; the only dependencies are the JSON Schema validator and its formats
state-machine.v1.json    run lifecycle as data: states, transitions, pause causes, failure reasons, clocks, cancellation policy
adapter-interface.v1.json operations every adapter implements, the behaviours each must exhibit, stop reason mapping
schemas/v1/              JSON Schemas (draft 2020-12) of every message and of the data files
examples/                valid and invalid documents, indexed by examples/manifest.json
lib/schemas.js           loads the schemas into a strict validator
lib/reference-model.js   pure functions: transition checks, event log invariants, cursor reads, cancellation policy, stop reason mapping
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

`npm install` is the only step that uses the network. The suite itself needs no network access and no harness. Cases that need a running broker, a real adapter or a real harness are listed in the report as skipped, each with its reason. A skipped case is never a pass.

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

## Naming in the data

Data files and JSON properties use `snake_case`. The reference model returns JavaScript objects in `camelCase`: `cancelPolicy` returns `sendToChild`, which corresponds to the `send_to_child` property of the state machine data.

## Versioning

Every document carries `schema_version`, which is `1` for this version. Adding a state, a transition, a failure reason or an event type requires publishing a new major version, `schemas/v2`, and a new data file. Version 1 documents are never changed in a way that alters their meaning.

## Adding an adapter

An adapter for a harness implements the operations of `adapter-interface.v1.json`, declares its capabilities as described by `schemas/v1/adapter-capabilities.schema.json`, and maps the native stop reasons with the mapping of the same file. To be conformant it must:

1. pass every case of the catalogue that applies to its declared capabilities;
2. have no skipped case of the contract level, and no skipped case of the harness level when its declared capabilities require it.

A case that cannot run must stay listed and skipped with its reason. Adding a new case means adding its id, its criteria, its scenario when it uses one, and its check to `conformance/cases.v1.json`, and the suite rejects a case whose referenced files do not exist.

## Not covered

This contract does not define:

- the authority policy that decides which requests are admitted, nor the reasons of the `rejected` state beyond their shape;
- the default values of the time limits and of the cancellation grace period, which are configuration of the broker;
- the storage of runs, the command line interface and the protocol server that expose the operations;
- resumption of sessions, idempotency keys for `delegate`, and a streaming subscription to events;
- the behaviour of Windows process groups, which the contract does not verify.
