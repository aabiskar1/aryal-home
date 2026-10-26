# Practical room darkness thresholds

After building, use an exact Home Assistant registry area name or alias:

```sh
npm run lighting-threshold -- --area "Example Room" --suggest
npm run lighting-threshold -- --area "Example Room" --set 40
npm run lighting-threshold -- --area "Example Room" --show
npm run lighting-threshold -- --area "Example Room" --reset
npm run lighting-threshold -- --help
```

The practical indoor starting point is **40 lx**. It is an adjustable heuristic, not a
universal darkness standard, a learned preference, or a claim about what a person wants.
Sensor placement and room use matter. Suggestion does not save a value; `--set` previews
the exact change and requires an interactive `y`/`yes`. Empty input, refusal or interruption
does not approve a change. There is no `--yes` bypass. Repeating an unchanged preference
does not write. Reset also requires confirmation and removes only that room's preference;
it does not install a default.

Values can be adjusted later without history analysis. Thresholds accept finite numeric
values from **1 through 1000 lx**, including decimals. To check a different starting
heuristic without saving it, use `--suggest --starting-lux 50`. `--suggest` and `--show`
support `--json`. Help requires no environment configuration or HA connectivity.

## Standalone evaluation, no automatic control

`evaluateDarkness()` is a reusable deterministic function accepting a threshold, an
illuminance measurement and an explicit current timestamp. It returns `dark` only when
valid lux is strictly below the threshold; equality is `not_dark`. Missing/invalid/stale
evidence returns `insufficient_context`. There is no inference from time, weather or
historical brightness when a current measurement is missing.

Measurements must be an exact `sensor`/`illuminance` observation in canonical `lx`, with a
finite nonnegative value and valid explicit-offset timestamps. The state value must have
changed within five minutes; attribute-only updates cannot make an old measurement fresh.
This conservatively rejects unchanged readings when their measurement time cannot be
established. Future timestamps and inconsistent change/update times are rejected.

The CLI reuses discovery, exact observation classification, registry area associations and
deny-overrides-allow policy. Denied, disabled, unavailable/unknown and incomplete metadata
sensors are excluded. Multiple eligible sensors remain ambiguous; none is arbitrarily
selected or averaged. Friendly names and state area hints never establish room membership.
A missing/invalid sensor still permits describing the practical default, but no lux value
or darkness assessment is invented.

**Nothing here is connected to AI planning, readiness, authorization or dispatch.** Saving a
preference grants no control or sensor exposure and does not make it a runtime condition.
The existing PR #14 `unresolved_illuminance_threshold` guard remains unchanged. Connecting
validated preferences to deterministic planning conditions is future work, separately scoped.

## What the historical check means

Suggestions optionally examine the last three rolling 24-hour periods (`--days 1` through
`--days 10` is supported). PR #15's bounded GET history client is reused: explicit permitted
entity filters and end times, daily sequential slices, 15-second request timeouts, no
retries/redirects, 8 MiB response limits and at most 200,000 retained samples. No logbook,
Ollama, external service, database or Recorder configuration access is used.

Historical ambient observations require a valid actual illuminance change and aligned
history showing every known room light permitted for the query was off for at least one
minute. Initial sensor snapshots, attribute-only changes, conflicting timestamps,
unknown/unavailable/restored light states and missing alignment do not qualify. Known
denied/unavailable room lights, registered room lights with missing states, unresolved light
registry metadata or excessive light counts prevent a complete lights-off check; their history
is never requested. Each daily response must include every requested entity; missing series
discard the historical check rather than carrying old off states across gaps.
Other unrecorded or misassigned lights may still
affect readings, so this is not proof of entirely natural lighting.

At most the first reading in each UTC half-hour bin contributes to the range check, avoiding
overweighting frequent sensor updates. Local dates/time-of-day and approximate historical
solar conditions use PR #15's HA-timezone/DST and configured-location calculation. These
are explanatory context, never a substitute for lux. Current location/timezone/room
metadata is assumed applicable historically; changes to those settings are unknown.

Twelve occupied half-hour bins across two local dates are required before reporting whether
the starting point lies within, below or above the observed 10th–90th percentile range.
The median and contextual counts are descriptive only. Even adequate observations do not
validate the full day: the report separately states whether both daylight and night were
sampled or whether daylight coverage is limited. Even sampling both is not proof of a preference.
Observations do not change the suggested number or establish a preferred threshold. An out-of-range result is
a reason to review placement/room conditions and adjust the heuristic, not an automatic
retuning rule. No confidence percentage or learned threshold is produced.

Incomplete/empty/unavailable history, unavailable solar configuration or insufficient
coverage retains an explicitly labelled practical starting point. Recorder retention,
exclusions and completeness cannot be established from these responses. Weather is not
used. Current valid measurements remain usable if optional history fails.

## Local preferences and privacy

Validated preferences live separately in gitignored `config/lighting-thresholds.json`:
version 1, with room entries containing a registry `areaId` and `thresholdLux`. Stable IDs
preserve preferences across area renames. Removed areas are not automatically reassigned.
Normal output shows room names and aggregates, never private registry IDs, credentials or
raw history. Local reports remain household-sensitive; sanitize them before sharing.

Reads never create files. Writes reject malformed/unknown schema fields, duplicate rooms,
invalid ranges, oversized files, symlinks and hardlinks. An exclusive writer lock and
comparison against the confirmed preview prevent silently replacing concurrent changes.
Same-directory atomic replacement uses private permissions and verifies the saved data.
Entity policy is never modified. The repository's existing `config` directory must exist.

Exit 0 means the operation completed (including declined changes or an insufficient-context
assessment), exit 1 means a data/transport/storage failure, and exit 2 means invalid arguments
or a noninteractive preference mutation. Errors never print raw exceptions.
