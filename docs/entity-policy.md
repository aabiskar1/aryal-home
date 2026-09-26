# Entity policy

ARYAL discovers currently existing entities from Home Assistant state data and then
resolves a local, default-deny policy against that discovery snapshot. Discovery never grants
permission by itself.

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

Version 1 supports `entityId` and `domain`. A selector must contain at least one supported field.
When both fields are present, both must match. Multiple selectors are alternatives, so an entity
only needs to match one allow selector. Any matching deny selector overrides every allow selector.
An empty `allow` array permits no entities.

Domains are derived from entity IDs by the application and are not taken from configuration or
model output. Future registry discovery can extend the selector with `areaId`, `deviceId`, and
`labelId` without changing the policy-resolution boundary.
