# Planning context and execution authority

The [project vision](vision.md) centres on context-driven local reasoning and useful
recommendations, with natural-language input as an optional interface. The separate
[explicit assessment pipeline](assessment.md) selects a compact typed room snapshot, invokes
Ollama once with an application-defined advisory goal, and independently validates its
recommendations. It may read saved darkness preferences; it cannot approve actions, create
dispatch commands, modify preferences or call execution. The instruction-driven planning
and execution boundaries below remain unchanged, including the illuminance refusal.

The standalone [room darkness threshold utility](lighting-thresholds.md) offers an adjustable
practical heuristic, read-only ambient checks and confirmed local preference storage. Its
deterministic evaluator and separate gitignored preferences are not imported by planning,
readiness or execution. Saving a preference neither grants exposure/control nor changes the
illuminance refusal. No model or Home Assistant mutation path is used by this utility.

The separate [advisory lighting learner](lighting-learning.md) reuses read-only discovery,
registry metadata and policy resolution, then collects bounded entity-filtered REST history
and logbook data. Event identification, historical solar/local-time enrichment, statistical
estimation and aggregate presentation remain separate modules. The REST collector cannot
establish direct human interaction from account attribution and cannot currently produce
threshold suggestions. No learning result is stored or consumed by planning, readiness or
execution; the illuminance refusal remains unchanged.

The separate [metadata audit](ha-audit.md) collects only current states, read-only registry lists,
and local policy. Pure inventory projection and deterministic findings support maintenance without
invoking model planning or execution. Audit suggestions grant no area, policy, or action authority
and make no changes to Home Assistant or local policy.

Home Assistant supplies current facts through validated REST state and registry metadata. A user
supplies the goal. The local model combines selected, normalized facts with that goal and proposes
structured entity or area/domain set intents. Deterministic application code owns permission,
complete set expansion, service routing, command construction, fresh authorization, dispatch, and
state confirmation.

Planning context separates two kinds of policy-permitted entities:

- `states`: actionable lights and switches, with current state and canonical supported actions.
- `observations`: read-only evidence, with entity ID, friendly name, area, state, device class, and
  an optional numeric measurement unit. Evidence contains no domain, supported action, service,
  target payload, or raw attributes.

When observations are supplied without actionable states or set scopes, planning uses
`observation_only` mode and a dedicated informational prompt. Its generated JSON Schema and strict
response parser permit only `no_action` or `insufficient_context` with an empty `actions` array;
neither entity actions nor set intents have a representable shape. Usable evidence answers the
question in the summary. Invalid control proposals are rejected before intent expansion rather than
converted into success. Existing policy/context validation remains a separate defense. Conditional
control requests with actionable states retain their existing entity, mixed, or set planning mode.

The immutable `src/observations/registry.ts` catalogue is the source of truth for exact Home
Assistant domain/device-class pairs, value kinds, and semantic profiles. Supported definitions are
`binary_sensor` / `occupancy` and `presence`, plus `sensor` / `temperature`, `humidity`, and
`illuminance`. Occupancy and presence share one presence evidence profile. The device-class Zod
schema and TypeScript union derive from the catalogue; there is no separate synchronized list.

Binary normalization accepts only exact `on`/`off`. Numeric normalization accepts finite signed,
decimal, or exponent strings and preserves the original state string; empty, malformed, non-finite,
unknown, and unavailable readings are unusable. Numeric units retain existing validation (trimmed,
nonempty strings up to 16 characters); binary evidence omits units. No arbitrary attributes enter
`ObservationState`. No class is inferred from a sensor's name, including names containing luminance.
Unknown/unavailable, disabled, and incomplete entities retain existing policy exclusions. Conclusive
legacy policies retain their REST-only planning fallback when registries are unavailable;
registry-dependent selectors still fail closed.

The dependency direction is normalization → registry, observation projection → normalization types
and registry, relevance → registry and projection, and audit inventory → normalization and projection.
The registry depends only on Zod. It imports no planner, projection, policy, or execution module.

To register a future supported class, add one compile-time definition with an exact domain and
`deviceClass`, `kind: 'numeric'` or `'binary'`, and a semantic profile containing an ID and narrowly
bounded phrases. Reuse an existing profile for interchangeable evidence. The kind selects the common
deterministic parser; a new class needs no class-specific branch in normalization, projection,
relevance, or audit. Add class-specific safety and regression tests and document supported semantics.
The internal constructor freezes the catalogue and derives lookup/schema data; it is not a user
configuration or plugin interface. Registration grants no exposure: the existing explicit policy
permission is still required. No sensor selectors are automatically added.

Relevance selection matches explicit evidence targets or the registered conservative phrases, using
Unicode tokenization and whole phrase boundaries. Entity IDs are removed from concept matching, and
matched friendly names are metadata rather than generic concept signals. “No one”, “no-one”, “noone”,
and “nobody” retain presence matching without rewriting the user's instruction sent to the model.
Area names/aliases or the actionable target's area narrow evidence.
Ambiguous fallback does not automatically include observations. Observation questions and recognized
conditional goals require the requested profiles; observation questions require evidence for every
matched requested area, and conditional room actions require evidence for each selected actionable
area. Missing or invalid required evidence returns `insufficient_context`.
For these area-dependent conditions, actionable entities without an area are excluded from model
action context and set membership; their names never supply a room assignment. They do not make
otherwise complete room evidence insufficient. An explicit conditional request for a no-area entity
still fails closed, including when it names a room or accompanies a broader collection request.
Existing explicit user-provided room facts continue to support semantic planning. The model must
report insufficient context for conditions it cannot establish and must never infer a light action
from occupancy alone or invent an automation.

Illuminance is a finite numeric read-only measurement, typically in `lx`. “Illuminance”, “lux”, “lx”,
“light level”, “how bright”, “how dark”, “brightness level”, and bounded “bright”, “dark”, or “dim”
select the illuminance profile. “Light” by itself does not. Measurement phrases do not introduce
lighting action context: “What is the Living Room light level?” and “How bright is the Living Room?”
use `observation_only`, while “Turn on Living Room lights if it is dark” retains the complete relevant
light context and illuminance evidence. Missing required evidence fails closed with
`missing_observations` before calling the model. Different-room or unassigned evidence cannot satisfy
an area-specific requirement. Invalid selected evidence is never silently dropped in favor of a
usable subset.

Measurement reporting and interpretation are separate. “How bright is the Living Room?” reports
the supplied lux value with `no_action`, just like a light-level question; a threshold is not needed
to report a reading. “Is it too dark?” requires a reliable interpretation criterion or preference,
so the model should use `insufficient_context` if that criterion is absent. Informational mode still
requires an empty actions array and the existing `Proposed plan:` summary contract.

`validateObservationConditions()` is an application-owned post-schema validation gate in the
planning pipeline, before entity/set intent expansion, policy validation, and readiness. No
deterministic illuminance comparator is registered in instruction-driven planning. Whenever its selected context combines
actionable states with illuminance evidence, this gate replaces the parsed model plan with
`insufficient_context` and empty actions, regardless of model confidence or current light states.
It preserves the complete mixed context and exposes a trusted `conditionIssue` diagnostic with
`unresolved_illuminance_threshold`: illuminance is available, but no reliable darkness/brightness
threshold has been established. This is distinct from `missing_observations`, which still rejects
missing, denied, or unusable required evidence before model generation.

Both qualitative conditions (“if dark”, “when dim”, “when bright”, “if the light level is low”) and
explicit numeric lux thresholds fail closed. Numeric unit spellings such as `50 lx`, `50lx`, and
`50lux` select the same illuminance profile after entity IDs and friendly names are masked.
A number in an instruction does not implement a
trusted comparator. This conservative gate also rejects combined control-and-illuminance-reporting
requests; it does not attempt to infer that two clauses are independent. Ordinary unconditional
light control without illuminance context and existing occupancy/presence conditions keep their
existing validation and complete-set behavior. No universal threshold, implicit preference, or new
execution permission is introduced. Illuminance does not grant brightness control:
“Set lights to 50% brightness” gains no additional action or parameter support. “It is dark” alone
provides no actionable targeting signal and cannot invent light context or unsolicited control.
Informational answers continue to use the existing `Proposed plan:` summary contract.

Every selected observation counts toward the existing complete serialized Ollama request budget,
including the prompt/schema and output headroom. An over-budget context is rejected as a whole;
neither a required observation set nor a complete action set is silently shortened.

Observation IDs never enter the actionable context ID set, advertised set scopes, or readiness
snapshot. A model proposal targeting an observation therefore fails post-model context validation.
The capability catalogue independently rejects its domain even if context membership is forged.
Readiness, fresh pre-dispatch revalidation, and private transport remain unchanged: only `light` and
`switch` with `turn_on`/`turn_off` can cross the execution boundary. DRY_RUN and confirmation timing
retain their existing behavior. Model requests contain no Home Assistant credentials or registry IDs.

Evidence is a planning snapshot. Fresh execution revalidation checks action-target state and policy;
it does not reevaluate occupancy or prove the user's semantic condition remains true. This change
adds no background automation or additional execution authority. See the [entity policy](entity-policy.md)
and [execution lifecycle](../README.md#deliberate-execution-and-confirmation) for the existing gates.
