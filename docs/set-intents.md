# Deterministic set intents

The model interprets semantic intent. Application code determines the complete matching permitted
entity set and owns all authorization, eligibility, routing, and execution checks.

The existing single-entity proposal remains unchanged:

```json
{
	"entityId": "light.example_target",
	"action": "turn_off",
	"reason": "An explicit target was requested."
}
```

A collection is represented by one strict intent, without enumerating entity IDs:

```json
{
	"type": "set_action",
	"action": "turn_off",
	"scope": {"area": "Example Area", "domain": "light"},
	"reason": "The instruction refers to the complete area light set."
}
```

Both shapes appear in `Plan.actions`. Outcomes retain their existing schema rules: at least one
intent for `propose_actions`, no intents for `no_action` or `insufficient_context`. Unknown fields,
unsupported domains/actions, service names, payloads, registry IDs, and selector dictionaries are
not accepted. Set domains come from the current application capability catalogue: `light`, `switch`.

## Scope and context

The planner receives a compact `setScopes` catalogue of area names, validated aliases, and domains.
Only complete permitted scopes present in selected normalized context are advertised. Registry
entity/device/parent area precedence is reused. Registry area IDs remain internal. State-attribute
area text alone cannot establish a set scope; unavailable metadata fails closed for set resolution.
Labels and whole-home sets are outside this version's scope.

Area matching applies Unicode NFKC normalization, trims surrounding whitespace, and ignores case;
it does not use fuzzy matching or invent aliases. If a name or alias identifies distinct effective
areas, expansion rejects `ambiguous_scope`, even if only one of those areas is permitted. Unknown
scopes and zero permitted matches also fail closed. A scope must have been shown to the model, and
every permitted member must be in the exact selected context; partial scope context is rejected.

Relevance selection keeps complete area/domain matches and preserves explicit IDs/friendly-name
targets. Observation language accompanied by control-domain terms retains controls alongside relevant
observations. The full serialized request, including prompt, schema, states, and scope catalogue,
is measured against the configured budget. Overflow returns `insufficient_context/over_budget`
before invoking Ollama. No members are silently truncated.

The prompt distinguishes a specific entity from a complete collection and ambiguous scope. Plural
language alone does not imply all. Contextual statements can justify a set when the user supplies
sufficient intent, such as an empty area with its lights still on. Semantic interpretation still
depends on the model; tests inject valid semantic outputs rather than claim a particular local
model will interpret every paraphrase correctly. Generation schemas use `entity_only` for explicit
ID/friendly-name context, `set_only` for explicit universal control wording, and `mixed` otherwise.
The exact selected schema and mode are included in budgeting. Responses still pass the strict
application schema and deterministic form checks; generation constraints never authorize actions.
Explicit universal control wording additionally
rejects individual model proposals as `set_intent_required`. A set returned for context selected by
an explicit entity ID or specific friendly name is rejected as `single_target_context`.

Deterministic invariant: without an explicit entity-ID/friendly-name targeting signal, an individual
proposal for a selected entity belonging to an effective area/supported-domain scope with more than
one permitted member is rejected as `contextual_subset_requires_set_intent`. This applies to every
such entity intent, including model-enumerated subsets or whole collections. Counts use unique
permitted entity IDs and effective registry area identity, separately per supported domain; no-op
members still count. The guard also holds when only part of that permitted scope was selected.
It does not infer all or manufacture a set intent: a proper model `set_action` uses existing expansion,
and an ambiguous scope can return `insufficient_context`.

A non-universal scope with exactly one permitted member may use an entity action, because there is
no arbitrary choice among permitted members. Denied/ineligible entities do not increase that count.
Explicit universal wording still requires `set_action`, even for one member. Exact entity-ID and
friendly-name targeting retain the existing entity path. CLI selection diagnostics expose
`intentMode` and the targeting reason; expansion diagnostics distinguish proper sets from rejected
contextual subsets without printing model summary/reason prose.

## Expansion and results

`expandPlanIntents()` resolves an untrusted semantic scope to validated effective area membership,
intersects domain and resolved policy with deny precedence, checks context completeness, and emits
every permitted member in stable entity-ID order. Device counts, names, and areas are data, not code.
`ConcretePlan` then goes through the existing `validatePlan()` and `prepareExecutionReadyCommands()`.
Single-entity proposals use that same downstream flow. Expansion does not construct service payloads.

Both CLIs expose `intentExpansion`: intent type/index, canonical resolved scope, `matchedCount`,
`expandedActions`, per-member readiness decisions, excluded counts, and rejected intent reasons.
Non-permitted inventory is never sent to Ollama; only aggregate exclusions are reported locally.
Model summary/reason prose is omitted from CLI diagnostics. Ineligible exclusions include unavailable,
unknown, and disabled members; other policy exclusions are counted as `notPermitted`. The existing
resolver groups explicit denials and ineligibility in its denied set; no permission rule is changed.

| Member or scope result                  | Behavior                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| Permitted, eligible, needs change       | Concrete proposal passes through policy/readiness                             |
| Already at requested state              | Existing readiness reports `no_op`; set diagnostic says `already_satisfied`   |
| Unavailable/unknown/disabled            | Excluded by current policy; reported as ineligible; eligible members continue |
| Denied or not allowed                   | Never expanded; aggregate policy exclusion; permitted members continue        |
| Duplicate/conflicting actions           | Existing readiness rejects affected members                                   |
| Unknown/ambiguous/zero/incomplete scope | No members expanded for that intent; rejected scope remains visible           |

Expansion outcome `complete` describes preparation, never execution success. `partial` means some
members are ready/already satisfied while material exclusions or rejections remain; `rejected`
means none were processable. `none` denotes the existing entity-only path. Mixed valid and rejected
intents retain the valid commands with incomplete diagnostics. `unprocessedCount` counts issues,
including repeated intent failures; it is not a distinct physical-device count.

Set no-ops do not block remaining commands or make an otherwise confirmed set partial. An entirely
already-satisfied set returns CLI `no_action` (exit 0), without dispatch or an execution-success claim.
Material exclusions or rejections prevent CLI complete success: confirmed remaining commands report
`partial_success` (exit 1). Single-entity no-op exit behavior is unchanged. Fresh authorization or
confirmation failures retain the existing execution outcomes. `DRY_RUN=true` still prevents every
service POST and returns exit 3 when ready commands reach the execution API.

Expanded commands enter only the existing `executeReadyCommands()` API. It re-reads production state,
registries, and policy immediately before dispatch and reauthorizes later commands after earlier
dispatch/confirmation deferral. Policy changes can remove members. No new transport or bypass exists.
Set membership comes from the planning snapshot: fresh checks reauthorize concrete targets; they do
not recalculate semantic scopes or add newly discovered members to an existing batch.

There is no hard-coded batch cap or interactive confirmation. Intent counts, matched/expanded member
counts, and separate readiness commands provide a future boundary for configurable large-batch
confirmation/risk thresholds before deliberate execution. That safety layer remains future work.
