# Repository Instructions

## Project purpose

This project is a local-first AI orchestration layer for Home Assistant. A local LLM provides contextual reasoning and planning, while deterministic application code retains authority over which actions are permitted and executed.

The intended flow is:

```text
Home Assistant
  -> entity discovery
  -> selector-based allow/deny policy resolution
  -> resolved allowed entities
  -> state normalization
  -> deterministic safety/rules
  -> local Ollama LLM
  -> structured proposed actions
  -> schema validation
  -> deterministic policy validation
  -> Home Assistant execution
```

The LLM is a planner and reasoning component. It is never an authority or execution engine.

## Deployment constraints

The project runs in a small Proxmox home lab:

- Dell OptiPlex 3060 SFF host with an Intel Core i5-8500 (6 cores/6 threads) and 16 GB RAM.
- Home Assistant OS runs in a separate VM.
- Ollama runs CPU-only in a separate Ubuntu LXC.
- The TypeScript orchestrator runs in another Ubuntu LXC.
- The currently preferred local model is Gemma 4 E2B.

Treat compute and memory as constrained. Prefer compact model context, relevant-state selection, event-driven processing, fewer LLM calls, reasonable timeouts, and simple infrastructure.

Keep model integration model-agnostic where practical.

Never put private IP addresses, private URLs, credentials, tokens, or installation-specific identifiers in source code or documentation.

## Safety invariants

Do not weaken these requirements without explicit approval:

- The LLM must never directly execute Home Assistant services.
- Treat all LLM output as untrusted input and validate it against a schema.
- Apply deterministic policy validation to proposed actions after model generation.
- Revalidate policy again at the final execution boundary.
- Only explicitly permitted entities may be controlled. Deny rules override allow rules.
- Never send the raw full Home Assistant state when normalized, relevant state is sufficient.
- Reject unknown entities and unsupported services.
- Reject duplicate and no-op actions when execution is implemented.
- Never claim success unless Home Assistant confirms the action.
- Never permit autonomous unlocking.
- Keep critical infrastructure entities denylisted.
- DRY_RUN=true must prevent every Home Assistant service POST, including through the execution API.

## Repository and privacy rules

This repository is public. Never commit:

- `.env`
- Home Assistant tokens or other credentials/secrets
- Private Home Assistant URLs or private LAN addresses where a generic example is sufficient
- Installation-specific `allowed-entities.json` or `denied-entities.json`
- Installation-specific `entity-policy.json`
- Private Home Assistant inventory or state dumps
- Real installation-specific entity IDs in public tests or examples

Use sanitized, generic values in public examples.

## Technology conventions

- TypeScript, Node.js 24+, and ESM
- Got for HTTP clients
- Zod for validation at runtime and external boundaries
- Vitest for tests
- XO for linting
- Prettier for formatting
- mise for development tool version management

Keep external API responses untrusted until validated. Prefer small modules with clear responsibilities. Keep HTTP transport, schemas, orchestration, policy validation, and execution separated. Avoid unnecessary dependencies.

## Development workflow

At the beginning of every development session:

1. Read `AGENTS.md` first.
2. Read `.codex/checkpoint.md` when it exists.
3. Verify checkpoint claims against the current branch, working tree, and repository contents before
   relying on them.

Maintain `.codex/checkpoint.md` as a local development checkpoint. Update it after every significant
completed task and whenever the user says they are stopping, pausing, finishing for the day, or
similar. Keep it concise and include the timestamp, current branch, sanitized Git status, current
milestone, completed work, architectural decisions, validation results, unresolved issues,
uncommitted work, and the exact recommended next step.

The checkpoint is gitignored and must never contain secrets, credentials, tokens, private URLs,
private IP addresses, installation-specific entity IDs, raw Home Assistant inventory, or contents
from installation-specific policy files. Verify its contents for privacy before writing it.

Before completing a change, run:

```sh
npm run format
npm run lint
npm run build
npm test
```

Do not make unrelated refactors during scoped work. Explain significant architectural changes before implementing them.

## Current development stage

Implemented:

- Home Assistant REST connectivity and state retrieval
- Zod validation of Home Assistant state
- State-based entity discovery with deterministic domain derivation
- Versioned selector-based entity policy supporting entity ID and domain selectors
- Default-deny policy resolution with deny-overrides-allow behavior
- Normalized AI-facing state
- Read-only Ollama planning with structured output validation
- Post-model validation against the resolved entity policy
- Discovery, policy, normalization, planning, and validation tests
- Registry enrichment, relevance selection, and deterministic execution readiness
- Fresh pre-dispatch policy/state revalidation with production-owned readers
- Separate sequential light/switch turn_on/turn_off dispatch API with fresh state confirmation
- Separate instruction-only execution CLI using the existing planning pipeline and execution API
- Semantic area/domain set intents with deterministic complete permitted-set expansion, shared
  post-model validation/readiness, and sanitized expansion diagnostics

The planning CLI remains read-only and stops at execution-ready commands. Deliberate execution uses
`executeReadyCommands()` to freshly authorize commands, dispatch only `DispatchAuthorizedCommand`
objects, and confirm current Home Assistant target state. Keep the lower-level dispatcher private.
Confirmation uses a bounded retry window for Home Assistant state propagation, retrying only valid
binary state mismatches and returning immediately on success or any other failure.
Service transport and confirmation helpers must remain non-exported within that same module.
DRY_RUN=true returns execution_disabled before authorization or confirmation reads; DRY_RUN=false
permits deliberately invoking the execution API. The planning CLI stays read-only in both cases.
Revalidate later commands after earlier dispatch/confirmation deferral. Do not broaden execution
beyond light/switch turn_on and turn_off or accept arbitrary service data without explicit scope.

After building, planning-only usage is `npm start -- "Turn off the example lamp"` with environment
variables configured (or `node --env-file=.env dist/index.js "Turn off the example lamp"`).
Deliberate execution is `npm run execute -- "Turn off the example lamp"`; it loads `.env` if present.
Keep `src/index.ts` read-only. The separate `src/execute.ts` wrapper calls `runExecutionCli()` and
only passes pipeline-produced readiness commands into `executeReadyCommands()`.
AI proposes; deterministic application code owns policy, current authorization, service routing,
dispatch, and confirmation. DRY_RUN=true may still plan but must never POST services.
CLI exit codes: 0 for all-confirmed with no earlier rejections or valid model no_action; 1 for
partial/rejected/insufficient-context/failed/error outcomes; 2 for invalid input; 3 for execution_disabled.
Never print raw exceptions, credentials, registry inventory, or untrusted model summary/reason prose
from the execution CLI. Partial success must remain visible and must not exit as complete success.

`Plan.actions` accepts existing concrete entity proposals or strict `set_action` intents using a
validated effective area name/alias, supported domain, and canonical action. Expand only complete
permitted scopes shown in model context; reject ambiguous, unknown, missing, or incomplete scopes.
Expanded `ConcretePlan` members must pass the existing policy/readiness pipeline. Set no-ops are
already satisfied; ineligible/non-permitted exclusions and material rejections keep outcomes partial.
Keep explicit entity targets single-target and explicit all/every requests from silently accepting
individual subsets. No labels/whole-home set scopes or batch confirmation thresholds are implemented.

Without an explicit entity-ID/friendly-name targeting signal, reject individual proposals belonging
to a relevant permitted area/domain scope with more than one member as
`contextual_subset_requires_set_intent`. Do not infer or convert to all: the model must return a proper
set intent or insufficient context. Non-universal scopes with one permitted member may use an entity
proposal; explicit universal requests still require set intents regardless of member count.
