# Read-only Home Assistant metadata audit

`ha-audit` is a local maintenance command for reviewing metadata that affects ARYAL reasoning.
It needs Home Assistant connectivity and `HA_URL`/`HA_TOKEN`, but no Ollama instance or model.
It loads `.env` if present; exported environment variables take precedence.

```sh
npm run build
npm run ha-audit
npm run ha-audit -- --json
npm run ha-audit -- --help
```

The tool performs only a GET of current states, authenticated read-only entity/device/area/label
registry lists, and a read of `config/entity-policy.json` if present. It never calls services,
updates registries, writes policy, or imports the execution/model pipeline. The shared state
reader retains runtime transport validation, timeouts, and retry behavior. Invalid/unreadable
policy is an audit failure; absent policy is reported with default-deny exposure and is not created.
Registry access must succeed: unlike runtime legacy-policy fallback, an audit cannot describe
registry quality without a registry snapshot.

## Inventory and findings

The inventory includes current state entities and registry-only entries. The latter are explicitly
marked `no_current_state`; an internal sentinel is used only to share metadata discovery, never
as real evidence or a planning input. Entity counts include both groups; `stateEntitiesScanned`
counts current state-based discovery. Device and area counts cover the retrieved registries.
Registry-only entries have no live device class in the existing schemas, so the audit does not
infer observation support from their names.

Findings use stable codes and `ERROR`/`WARN`/`INFO` severity:

`WARN` means a finding could affect ARYAL's configured reasoning/control surface: a current
light/switch or supported observation with no recorded disablement, matched by allow selectors
without a deny match.
Temporarily unavailable/unknown states and incomplete metadata can still warrant review, but
they remain excluded by runtime eligibility checks. Audit-only selector evaluation uses copies
to ignore those eligibility failures; unknown registry selectors cannot match an allow and
unknown deny selectors still block relevance. This never changes current policy permission.
The `aryalRelevant` detail is an attention flag, not authorization or observation readiness.

Non-permitted, unsupported, disabled, and registry-only entities retain their metadata/state
findings as `INFO`. Explicit missing policy references remain `WARN` regardless of domain.
Incomplete registry references are review findings (`WARN` when relevant, otherwise `INFO`),
not audit failures. Access/validation failures still prevent completion.

- Missing effective areas for light/switch controls and supported observations. Entity, direct
  device, and parent-device area provenance remain distinct. State attributes and names never
  supply audit area authority.
- Entity/direct-device area overrides and multiple effective areas among one device's entities.
  Overrides may be intentional. Device-wide conflicts warn only when relevant members occupy
  multiple areas; unrelated members remain visible without elevating the finding.
- Duplicate friendly names, compared after Unicode normalization, trimming, and lowercasing.
  Exact duplicates are distinguished from normalized duplicates. Generic-name warnings apply
  only to exact `light`, `switch`, `sensor`, `temperature`, `humidity`, `occupancy`, or `presence` names.
  Duplicates warn only for relevant members when at least two relevant members share the name.
  Expected cross-domain pairs outside this surface remain informational. All group IDs are retained.
- Current `unknown`/`unavailable` states, registry-only entries, incomplete references, and
  entity/device/parent disablement. No timestamp-based stale inference is performed. This version
  uses the disablement fields available in the existing registry schemas; it does not collect
  additional integration/removal metadata.
- A conservative actionable-name hint for whole `status`, `indicator`, `diagnostic`, or `debug`
  tokens in friendly names or entity IDs. It does not classify safety, deny an entity, or infer
  what the device controls. It warns only when the entity is currently policy permitted.
- Explicit allow/deny entity references absent from current state-based discovery, with an
  indication of whether a registry-only entry still exists. Domain-wide selectors are not stale
  entity references. Intentional deny entries need not be removed.

Every supported observation has an informational readiness finding. Support means binary sensors
with occupancy/presence device classes or sensors with temperature/humidity classes. Normalizability
and usable state follow the existing `ObservationState` projection: binary `on`/`off` or a finite
numeric reading. Unsupported classes receive no observation-readiness finding.
Invalid supported readings have a separate relevance-ranked `unusable_observation_state` finding;
`unknown`/`unavailable` use `unusable_current_state` instead.

`policyExposed`/`policyPermitted` report the existing resolver's **current** permission, including
deny overrides and disabled/incomplete/unavailable/unknown exclusions. This is not merely a test
for an allow selector. Omission reasons separate unusable observation state, disablement, incomplete
metadata, and lack of current permission. `eligibleForPlanning` means it can be considered as
evidence; actual relevance and request-budget selection remain request-dependent. A missing area
does not prohibit unscoped evidence, but `areaReasoningReady` is false. Observation exposure is
read-only and grants no action authority.

Actionable readiness findings list only existing light/switch `turn_on`/`turn_off` capabilities,
current policy permission, binary-state usability, and area presence. These are review hints,
not `ExecutionReadyCommand` or `DispatchAuthorizedCommand` values. All runtime planning, complete
set expansion, readiness, fresh revalidation, DRY_RUN, and confirmation gates remain unchanged.

## Output and exit codes

Human output includes a count summary and deterministic findings with reasons and suggestions.
Errors and warnings precede informational details, with stable ordering within each severity.
Routine disabled/registry-only status findings are summarized by code count in human output;
JSON retains every per-entity detail. All warnings, errors, readiness, and policy findings remain
individually visible.
`--json` returns a stable `{summary, findings}` object without timestamps or raw payloads. Findings
can be consumed without npm's script banner using `npm --silent run ha-audit -- --json`. Findings
in JSON are ordered by entity ID, device ID, and code; group members are sorted independently of HA response
order. The report includes only curated metadata and recognized states, not arbitrary attributes,
raw errors, auth/config values, or registry dumps. Known credentials, configured addresses, URL/IP
strings, and terminal control characters are removed from displayed string values.

| Exit code | Meaning                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| `0`       | Audit completed, including when ERROR/WARN/INFO findings exist; or help displayed            |
| `1`       | HA configuration, state access/validation, registry access, or policy read/validation failed |
| `2`       | Invalid CLI arguments                                                                        |

Suggested names/area assignments are review hints, never runtime authority. Assignments must be
reviewed and made deliberately in Home Assistant; ARYAL continues to use validated registry
metadata for area scopes. **The tool does not modify Home Assistant or entity-policy.json.**
Audit output intentionally identifies local entities and rooms. Treat it as installation-sensitive
and share only sanitized counts and representative finding codes, not full inventories.
