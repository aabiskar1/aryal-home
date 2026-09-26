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
