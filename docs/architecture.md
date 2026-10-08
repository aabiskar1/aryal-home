# Planning context and execution authority

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

The initial evidence catalogue is intentionally narrow: binary sensors with `occupancy` or
`presence` device classes and sensors with `temperature` or `humidity` device classes. Binary
observations must report `on`/`off`; numeric observations must report a finite decimal number.
No class is inferred from a sensor's name. Unknown/unavailable, disabled, and incomplete entities
retain existing policy exclusions. Conclusive legacy policies retain their REST-only planning
fallback when registries are unavailable; registry-dependent selectors still fail closed.

Relevance selection matches explicit evidence targets or a small presence/temperature/humidity
vocabulary and uses area names/aliases or the actionable target's area to narrow evidence.
Ambiguous fallback does not automatically include observations. Observation questions and recognized
conditional goals require the requested profiles; observation questions require evidence for every
matched requested area, and conditional room actions require evidence for each selected actionable
area. Missing or invalid required evidence returns `insufficient_context`.
Existing explicit user-provided room facts continue to support semantic planning. The model must
report insufficient context for conditions it cannot establish and must never infer a light action
from occupancy alone or invent an automation.

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
