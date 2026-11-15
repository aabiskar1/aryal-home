# Explicit context-driven assessment

After building, run `npm run assess-home -- --area "Example Room"`. This read-only
workflow defaults to the application-defined `lighting_comfort` goal and accepts no natural-language
instruction. It demonstrates the [context-driven vision](vision.md) independently of
instruction-driven planning. It does not schedule work, modify preferences, approve
actions, construct service commands or invoke execution. DRY_RUN does not change that.

The second goal, [environment_comfort](environment-assessment.md), combines permitted indoor
temperature/humidity with separately scoped current Home Assistant weather and local time:
`npm run assess-home -- --area "Example Room" --goal environment_comfort`. It returns validated
informational insights or conditional requests to review missing context, never device actions.
The lighting-specific context and validation described below retain their existing behaviour.

The implementation separates context selection (`src/assessment/context.ts`), strict
schemas, one-call Ollama reasoning, deterministic validation and pipeline coordination.
The CLI uses the existing validated current-state/registry collector, entity policy,
observation projection, local preference reader, Home Assistant GET config and Ollama
chat transport. No external calendar/weather service, history analysis, learning or
generic plugin framework is introduced.

## Snapshot sources and selection

- Current light states: only policy-permitted, enabled, registry-resolved lights in the
  exact selected area. Names and state-provided area hints never establish membership.
  State retrieval supplies a snapshot at `capturedAt`; a light's old last-change time
  does not itself make an unchanged on/off state stale. Only on/off states are usable.
- Illuminance: permitted exact `sensor` / `illuminance` observations, normalized by the
  existing registry/projection. Require finite nonnegative lux with exact `lx` units,
  valid explicit-offset timestamps and last-change age at most five minutes. Attribute
  updates do not refresh a measurement. Restored/invalid samples are unusable.
- Occupancy/presence: permitted exact binary_sensor classes, exact on/off values and
  the same conservative five-minute last-change freshness. Motion, person/device_tracker
  entities, whole-home presence and friendly-name guesses are not room occupancy.
  Missing, stale or invalid presence means unknown. Fresh disagreement means conflicting.
- Approved threshold: the existing validated local preference file, matched by stable
  registry area ID. This trusts the same local store written through PR #16 confirmation;
  it does not independently certify hand-edited files. No saved threshold means missing.
  The practical 40 lx suggestion is never substituted. Assessment never writes the file.
- Time/daylight: current system time plus validated Home Assistant configured timezone
  and location, using the existing approximate solar calculation. No coordinates are
  exposed to the model. Config failure is explicitly unavailable and does not invalidate
  otherwise sufficient direct lux evidence. Time/daylight never establishes darkness.

The strict versioned envelope keeps actionable `states`, read-only `observations`,
preferences and clock context separate. Every selected signal carries its source and
availability/freshness information. Other evidence sources can be added as small typed
fields after their own boundary design; unsupported sources are not implied today.

Only selected permitted evidence is projected. Unavailable/disabled/denied entities
retain existing policy exclusions. Ambiguous area names, unavailable registries,
incomplete metadata for an entity and duplicate state identities cannot establish
membership/eligibility. Unusable selected evidence remains explicit rather than silently
falling back to one good sensor. Multiple lux sensors must agree on the threshold side.
This is not a claim of complete installation inventory or historical lights-off coverage.

The model receives application-generated `light_1` / `observation_1` references, never
entity IDs, friendly names, area names/aliases, raw attributes, credentials, registry IDs,
coordinates or the complete Home Assistant state. Target mappings stay private to the
invocation. Removing external descriptive metadata also removes a prompt-injection
surface. External evidence is still treated as untrusted data, not instructions.

Complete selection is limited to 16 lights and 16 observations. Larger selections fail
closed without truncation. The full serialized Ollama request, including model name,
prompt, schema and 4,096 bytes of output headroom, must fit the smaller of the existing
PLANNING_REQUEST_MAX_BYTES setting and 24,576 bytes. Oversized requests skip the model;
responses over 4,096 bytes are rejected before JSON parsing. There is at most one model call,
no application retry and the existing bounded local transport timeout.

## Reasoning and deterministic recommendation

Before generation, shared deterministic evidence checks return trusted `insufficient_context`
without calling Ollama when the approved threshold, usable current lux, permitted lights or
consistent required evidence is missing. The validated context snapshot and issue codes remain
available; `model: not_called` and `validation: not_run` indicate no model proposal was validated.
Unknown presence and unavailable solar context remain optional; bright conditions, clear presence
and already-on lights can still support a valid model `no_action` decision.

For sufficient evidence, Ollama receives the fixed goal and structured context.
It may return `suggest_action`, `no_action` or
`insufficient_context` through a strict discriminated Zod/JSON Schema. Suggestions
contain only known light references and `turn_on`; the other outcomes require empty
actions. Rationale is bounded to 320 characters and presence classification is explicit.

Application validation independently requires a configured threshold, fresh usable lux,
agreement across selected lux sensors and targets in the selected permitted light map.
It repeats freshness checks after generation, rejects snapshots older than five minutes,
duplicates, invented targets and already-on lights. A darkness-based suggestion must be
strictly below the approved threshold; equality is not dark. It rejects suggestions when
fresh presence is clear or conflicting. Unknown presence may support a conditional
recommendation, with an application-owned explanation that room use must be confirmed.
Detected presence never proves the user's desire for lighting.

An accepted model `no_action` is allowed when the necessary decision context is complete;
the model is not forced to suggest every eligible action. Missing required evidence
produces `insufficient_context`, even if the model claims otherwise. A whole suggestion
is rejected when any target fails; there is no partial action acceptance. Model outage,
malformed JSON, unknown fields, unsupported actions and excessive output are labelled.
The result includes model/validation status, trusted issue codes and no execution authority.

Model rationale is untrusted and is not echoed to the CLI. Accepted recommendations use
application-owned, evidence-derived text, so hallucinated occupancy or injected prose
cannot become a user-facing factual claim. Recommendations contain `proposedAction`
and an advisory kind, with no service, arbitrary data or dispatch-authorized command.
They are not accepted input to the execution CLI. Context and preferences are snapshots,
not ongoing guarantees or approval tokens.

Exit codes: 0 for accepted suggestions or no_action; 1 for insufficient, rejected,
invalid or unavailable outcomes; 2 for invalid arguments. JSON output contains only the
selected normalized snapshot and sanitized decision. Household results remain private:
sanitize them before sharing. No raw exceptions or model prose are printed.

The existing instruction-driven PR #14 `unresolved_illuminance_threshold` guard remains
unchanged, even when this separate advisory path has an approved threshold. Planning,
readiness, fresh authorization and dispatch do not import assessment. Future milestones
may add reviewed triggers and approval/notification workflows; they require separate scope.
