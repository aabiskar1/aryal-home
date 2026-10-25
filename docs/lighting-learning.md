# Advisory lighting history analysis

```sh
npm run build
npm run learn-lighting -- --area "Example Room" --days 10
npm run learn-lighting -- --area "Example Room" --days 10 --json
npm run learn-lighting -- --help
```

This explicitly invoked command discovers a room's permitted illuminance sensor and lights,
examines recorded light-on events and reports evidence quality. It uses `HA_URL`/`HA_TOKEN`,
loads `.env` if present, and needs no model or new configuration file. The area must match
one registry name or alias unambiguously. Days default to 10 and accept integers from 1
through 30, measured as rolling 24-hour periods. Local calendar days are used for grouping;
a ten-day rolling window can intersect eleven local dates.

**No preference is activated or stored.** There are no services, notifications, schedules,
Recorder changes, policy changes or new execution permissions. Planning, readiness,
dispatch, DRY_RUN and `unresolved_illuminance_threshold` are unchanged. An estimate describes
historical behavior; it is not proof of a household's preferred threshold.

## Current provenance limitation

The production REST collector **cannot currently produce a threshold suggestion**. This is
an intentional evidence boundary. The history response tested on the installation omits
context entirely. Filtered logbook data can add attribution, but cannot reliably distinguish
a person operating a UI/device from software using that person's account. A null parent
plus a user ID is not proof of direct interaction. There is no CLI override to assert it.

The pure estimator accepts separately attested `interaction_supported` inputs for fixtures
and a future evidence adapter. No current external-data parser or production collector
constructs that value. Unknown and account-attributed events never silently qualify as
reliable manual-preference evidence. A future adapter must establish this contract
independently, rather than renaming existing account IDs.

Attribution classes are:

- `automation_or_script_attributed`: an exactly matched logbook state entry attributes the
  event to an automation/script domain or entity.
- `external_context_attributed`: another source entity/domain or a history parent context
  exists; this neither identifies a human nor proves automation.
- `user_attributed_origin_unverified`: an account ID exists without stronger source
  attribution; tokens and external software can use accounts too.
- `unknown_origin`: available records establish none of the above.

Logbook joins require the same entity, state and timestamp instant. Missing logbook access
leaves provenance uncertain. No users are enumerated; IDs never appear in ordinary output.

## Collection and bounds

Existing state discovery, registry enrichment and deny-overrides-allow resolution are
reused. Exactly one permitted `sensor` with the observation registry's exact `illuminance`
class, a valid nonnegative reading and canonical `lx` units is required. Multiple permitted
sensors are rejected instead of averaged or selected arbitrarily. Only permitted `light`
entities are included. Disabled, unavailable/unknown and incomplete metadata entries are
excluded. Room membership comes from validated entity/device/parent-device registry
associations, never names or state `area_name` hints. Registry failure prevents collection.
Current metadata is assumed applicable historically; past room assignments are unknown.

Supported REST endpoints used:

- `GET /api/config`: retains validated timezone and location for temporal/solar context.
  Coordinates are never printed.
- `GET /api/history/period/<start>`: explicit `filter_entity_id` and `end_time`, with
  `significant_changes_only=0` to preserve attribute/availability evidence.
- `GET /api/logbook/<start>`: explicit light-only `entity` filter and `end_time`.

History and logbook requests run sequentially in daily slices, for at most one sensor and
16 lights. No unfiltered history/logbook query exists. Each response has an 8 MiB streamed,
decompressed byte limit before JSON parsing, a 15-second timeout, no retries and no redirects.
Limits are 50,000 rows per entity/response and 200,000 combined retained history/logbook
samples. Budget failure stops analysis without trimming evidence. There are at most 30
history and 30 logbook requests. Logbook failure stops further logbook queries and discards
partial attribution.

Full history responses retain `entity_id`, `state`, `last_changed`, `last_updated`, selected
attributes and optional context. `minimal_response` and `no_attributes` are deliberately
unused because they can omit evidence needed by analysis. Only device class, measurement
unit and restoration attributes survive validation; names and arbitrary attributes are
discarded. Explicit timestamp offsets are required. Malformed/unsolicited responses fail.

Empty/missing series produce explicit insufficient-history outcomes. Reports show days with
actual updates, missing series and sample counts, without claiming a complete recording
window. These APIs do not establish whether missing data means Recorder exclusions,
retention/purging, a new/quiet entity or another gap. Retention and exclusions are explicitly
unverified. No database or Recorder configuration is accessed.

References: [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/),
[history serialization](https://github.com/home-assistant/core/blob/dev/homeassistant/components/recorder/models/state.py),
[logbook attribution](https://github.com/home-assistant/core/blob/dev/homeassistant/components/logbook/processor.py).
Upstream implementations evolve; optional fields are never assumed present.

## Events and illuminance

The first record of each entity's daily response is conservatively a snapshot, not an
action or a newly measured lux sample. Other records are sorted and deduplicated;
conflicting values at one timestamp become unusable barriers. Only actual `off -> on`
transitions inside the window are considered. Initial, attribute-only, restored and
unknown/unavailable transitions do not count.

Known aggregate lights are detected from their explicit current `entity_id` membership
attribute; their own transitions are excluded. Current membership does not prove historical
membership or authorize reading denied/other-room members. Member changes sharing an actual
history context ID within five seconds collapse to one episode. Similar timing without
shared context establishes neither one action nor independent decisions: events stay
descriptive with independence unestablished. Remaining candidates require 30-minute
separation for statistical independence. Unrecognized groups cannot be inferred from names.

Each candidate uses the latest actual sensor record strictly before the event, at most
five minutes old by `last_changed`, with exact illuminance class, `lx`, and a finite nonnegative value.
Attribute-only updates cannot make an unchanged old value fresh; this can conservatively reject
a genuine repeated equal measurement when the API cannot establish its measurement time.
Same-time/later readings are never used. An invalid latest reading blocks falling back to
older values; missing values are never interpolated. Sampling gaps are exclusions. Other
lighting, sensor placement and room use can still confound readings. Light-off readings are
unused because artificial lighting may already affect them.

## Statistics and context

Only independently supported interaction episodes with fresh lux can support an estimate.
Minimum evidence is eight episodes across four local dates. Interpolated quartiles define
1.5 IQR outlier fences. More than one fifth outliers, or remaining evidence below either
minimum, prevents an estimate. The estimate is the median of daily medians, avoiding busy-day
dominance. Refuse a pooled estimate when IQR exceeds `max(10 lx, median * 0.5)` or daily
medians span more than `max(15 lx, median * 0.75)`. These conservative analysis gates are
not control thresholds and need validation against future independently attested data.

Every descriptive episode carries local date/time and UTC offset using HA's configured
IANA timezone and `Intl`, including DST. Approximate geometric solar elevation at that
historical timestamp uses configured latitude/longitude and the
[NOAA general solar equations](https://gml.noaa.gov/grad/solcalc/solareqns.PDF).
No current sun state is substituted. Daylight means above +1 degree, civil twilight between
-5 and -1, and night below -7. One-degree bands around 0 and -6 degrees are
`boundary_uncertain`. These explanatory approximations are not exact sunrise/sunset times,
brightness measurements or execution conditions. Refraction, terrain and weather are not
modeled. Current location/timezone is assumed applicable historically; configuration changes
are unknown.

Compare daylight and fixed local time-of-day groups (00-06, 06-12, 12-18, 18-24). Groups need
four samples across two dates. Supported group medians differing by more than
`max(10 lx, estimate * 0.5)` prevent a pooled suggestion. Context is assessed on all usable
evidence before outlier removal can hide a minority pattern. Smaller groups are insufficient
for comparison; no separate thresholds are fitted. No confidence percentage is invented,
and additional metadata never raises confidence by itself.

Historical weather/cloud correlation is **deferred**, explicitly `not_collected`. No weather
history, current conditions, forecasts or external services are used. Missing weather alone
does not disqualify otherwise valid evidence. A future extension needs permitted sources,
historical observation semantics and bounded timestamp alignment; an old forecast is not
automatically an observation.

## Output and future activation

Human/JSON output contains aggregate counts, exclusions, reason codes and contextual
availability. Raw events, entity/device/user/context IDs, coordinates and exact event times
are omitted. Area names appear locally: sanitize household-sensitive reports before sharing.
Credentials, addresses and terminal control characters are redacted. Exit 0 means completed
analysis, including insufficient evidence; 1 means configuration/transport/validation/budget
failure; 2 means invalid arguments. Help needs no HA access. Raw exceptions are never printed.

Future work must establish interaction evidence, then separately design explicit approval,
validated storage and deterministic condition evaluation. An estimate must never itself grant
permission, bypass the existing illuminance refusal, or become an execution condition. No
storage, approval or activation mechanism is included.
