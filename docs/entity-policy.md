# Entity policy

ARYAL discovers current entities from Home Assistant REST state data and joins validated entity,
device, area, and label registry metadata from a short-lived, read-only WebSocket connection. It
then resolves a local, default-deny policy. Discovery never grants permission by itself, and
registry-only entries are never candidates for control.

Copy `config/entity-policy.example.json` to the ignored `config/entity-policy.json` and adjust it
for the local Home Assistant installation. Never commit the local policy file.

## Schema

```json
{
	"version": 1,
	"allow": [{"domain": "light"}, {"entityId": "switch.example_switch"}],
	"deny": [{"domain": "lock"}]
}
```

Version 1 remains compatible and supports `entityId` and `domain`. Version 2 also supports
`deviceId`, `areaId`, and `labelId`:

```json
{
	"version": 2,
	"allow": [{"areaId": "example_room"}, {"entityId": "switch.example_switch"}],
	"deny": [{"deviceId": "example_critical_device"}, {"labelId": "example_restricted"}]
}
```

A selector must contain at least one supported field. All fields in one selector must match (AND).
Multiple selectors in an allow or deny array are alternatives (OR). Any matching deny selector
overrides every allow selector. An empty `allow` array permits no entities. Unknown fields are
rejected.

Domains are derived from entity IDs, not model output. An entity-level area assignment overrides
its device area; a child device without an area can use its parent device's area. A label selector
matches labels directly assigned to the entity, its device, or its effective area. Parent-device
labels are not inherited.

If a registry request fails, registry metadata is explicitly unavailable. An allow rule requiring
unavailable metadata cannot grant access; a potentially matching deny rule requiring it blocks
the candidate. Existing `entityId`/`domain`-only rules can still resolve against current REST
state when their outcome is conclusive. An incomplete registry relationship (for example, a
missing referenced device) withholds control, including for version 1 policies. Known disabled
entities or devices and entities whose current state is `unavailable` or `unknown` also cannot be
proposed for control. Registry IDs and labels stay inside discovery and policy resolution; they
are not included in Ollama state context.

Relevance selection runs after this policy is resolved. It may reduce which permitted entities
reach the model, but it cannot grant access or bypass a deny. Post-model action validation requires
both full-policy permission and membership in the exact selected model context.

Planning-time `ValidatedAction` proposals then enter a separate deterministic execution-readiness
layer. It rejects duplicates, conflicting actions, and no-ops against the selected normalized
snapshot, and constructs application-owned domain/service/single-entity-target commands with no
service data. Readiness cannot grant permission or recover a proposal rejected by policy or context
validation. See [execution readiness](../README.md#execution-readiness) for rejection semantics.

Readiness has separate outcomes: `ready` when at least one command is prepared, `rejected` when
readiness rejects all planning-accepted proposals, and preserved planning `no_action` or
`insufficient_context` outcomes. Rejected proposals do not become a readiness `no_action` conclusion.

The planning CLI stops after preparation. An independent `revalidateForDispatch()` boundary reloads
states, registries, and the local policy once per batch, reruns discovery, and resolves policy over
the fresh inventory. Removed allows, newly matching denies, and changed effective area/device/label
metadata can therefore reject a previously ready command. Deny still overrides allow; no planning
permission is reused. Current target eligibility is checked before policy rejection diagnostics.
The production function accepts commands only and owns its state, registry, and policy reader wiring;
callers cannot replace those readers with cached snapshots. Tests mock the underlying read dependencies.

Fresh registry failure rejects this boundary even when legacy selectors could conclusively allow
REST-only planning: disablement cannot be established without fresh registry metadata. Incomplete
relationships, disabled targets, ambiguous target state, and unknown/unavailable state also withhold
dispatch authorization. See [fresh revalidation](../README.md#fresh-pre-dispatch-revalidation) for
the full outcome and rejection semantics.

Passing commands are reconstructed as the distinct `DispatchAuthorizedCommand` type with exact
application-owned domain/service/target fields and no service data. Revalidation itself remains
read-only. The separate production `executeReadyCommands()` API revalidates the initial batch, sends
only newly authorized commands to its private dispatcher, and performs sequential light/switch
`turn_on`/`turn_off` service POSTs with exactly one `entity_id`. No arbitrary service data is accepted.
DRY_RUN=true blocks the execution API before any fresh authorization or confirmation reads, returning
the dedicated execution_disabled outcome and dry_run reason rather than a policy rejection or success.
Only DRY_RUN=false permits deliberate execution. The raw transport, HTTP client, and confirmation
helpers are non-exported and colocated with the private dispatcher; there is no direct transport API
or test bypass. A private POST guard also enforces DRY_RUN before any service request.
Later eligible commands are revalidated again immediately before their POST, since earlier execution
and confirmation deferred them. Initial rejections stay rejected; no old authorization is cached or
queued. Planning-time readiness and earlier authorization are not permanent permission.

Each successful service response requires a fresh target-state read before reporting `confirmed`.
Bounded retries for valid binary state mismatches accommodate Home Assistant state propagation.
Missing, ineligible, malformed, or unreadable state fails confirmation immediately. HTTP
success alone is not execution success. Partial success is reported without rollback or POST retries.
See [execution and confirmation](../README.md#deliberate-execution-and-confirmation) for result types,
failure reasons, transport bounds, and lifecycle. The planning CLI stays non-executing; delayed commands
must be freshly revalidated again. Keep critical infrastructure denylisted and never permit autonomous
unlocking.
