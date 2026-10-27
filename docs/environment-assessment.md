# Multi-source environmental assessment

After building, run:

```sh
npm run assess-home -- --area "Example Room" --goal environment_comfort
```

The default goal remains `lighting_comfort`. Environmental assessment uses the same
explicit invocation, validated collection, policy resolver, compact context, bounded
Ollama transport, preflight and post-model validation pattern. It adds no command parser,
provider framework, external weather client, forecast request, monitoring or control path.
See the [vision](vision.md) and [assessment foundation](assessment.md).

## Selected sources

Indoor `sensor` temperature/humidity and `binary_sensor` occupancy/presence require exact
registry-backed membership in the requested area and explicit allow/deny policy permission.
Names and state area hints do not establish membership. Disabled or incomplete metadata
is ineligible. Unknown/unavailable values from explicitly permitted read-only sources
are retained only as availability diagnostics, with null values. The existing selector
resolver is applied to an availability-only projection of these read-only candidates;
deny selectors and metadata exclusions remain authoritative. This projection is never
used for actionable states, lighting assessment, planning or execution.

Current weather comes only from existing Home Assistant `weather` entity states. It is
installation-level context, even if a registry happens to assign the entity to a room.
Weather needs its own explicit policy permission; allowing room sensors or lights does
not implicitly allow weather. Exactly one eligible, permitted weather source must exist.
Multiple permitted sources are labelled `multiple_sources`, even when their current values
agree. ARYAL never silently selects a preferred provider or mixes their attributes.
No permitted source yields `missing_or_not_permitted`; it does not imply weather availability.

Only the documented [current conditions and attributes](https://www.home-assistant.io/integrations/weather/#state-and-state-attributes)
are projected: condition, temperature with an explicit supported unit, and relative humidity
in Home Assistant's documented percent units. Optional attributes can be missing or invalid
without inventing replacements. Unknown/unavailable conditions, invalid timestamps, restored
state and unrecognized condition strings cannot establish current weather. Forecasts, names,
coordinates, attribution text, raw attributes, entity IDs and registry IDs never reach Ollama.

If configuration is needed, review `config/entity-policy.json` locally. Add allow selectors
only for the intended indoor observations and one intended current weather entity, for example
`{"entityId":"weather.example_current"}`. Existing deny selectors still override this grant.
If a broad weather grant selects several sources, narrow the grant or explicitly deny unwanted
sources after reviewing them. ARYAL never modifies policy automatically. Weather exposure grants
no supported control action or Home Assistant service permission.

## Values, availability and freshness

Indoor numeric normalization reuses the observation catalogue/projection. Temperature accepts
exact `°C`, `°F` or `K`, converts to Celsius and retains the original unit. Humidity requires
`%` and a value in 0–100. Temperatures below absolute zero and non-finite/non-decimal values
are invalid. Weather attributes must be actual finite numbers, not numeric strings.
Canonical temperatures round to six decimal places for stable cross-unit comparisons.

Indoor readings retain PR #17's conservative five-minute `last_changed` freshness; attribute
updates do not refresh a measurement. Weather uses a five-minute `last_updated` snapshot age,
after validating timestamp syntax, ordering and future times: a weather condition can stay
unchanged while its current temperature/humidity attributes update. This proves only recent
Home Assistant state updates, not the provider's physical measurement time, which is explicitly
`provider_measurement_time_unknown`. A provider updating less frequently may remain insufficient.

Each source carries provenance, scope, availability, timestamps and its freshness basis.
Missing, unavailable, invalid and stale observations are not numbers. Different canonical values
among selected indoor sensors of the same numeric class make that profile conflicting; there
is no averaging or arbitrary subset selection. A different usable profile can still support an
insight, but a claim cannot cite a conflicting or otherwise unusable profile. Missing/stale
presence stays unknown; presence conflicts stay explicit. Neither determines physical temperature
or humidity, and neither proves the user's intent.

The model receives separate indoor observations, installation weather, configured local time,
unknown environmental preferences and an empty actionable `states` list. Local time/approximate
solar context reuse Home Assistant configuration and the system clock; failure is explicit and
optional. Time and weather words never substitute for measurements. Environmental assessment
does not read or interpret the lighting preference file as a comfort preference.

## Reasoning and independent checks

Preflight skips Ollama when the snapshot is unusable, weather condition is not current/unambiguous,
or neither indoor temperature nor humidity has usable evidence. An outdoor numeric attribute is
required only for a claim comparing that quantity. Valid indoor evidence plus current weather can
still justify asking for comfort preferences even when optional outdoor attributes are missing.
Unknown preferences and missing presence do not block informational comparisons.

Strict model output supports `insight`, `recommend_review`, `no_action` or `insufficient_context`.
Insights/reviews use bounded categories, weather condition, relative temperature/humidity claims,
explicit presence and references to supporting normalized evidence. They cannot represent device
actions, services, forecasts, window/heating states or comfort thresholds. Rationale is bounded to
320 characters and never echoed as factual proof.

Application validation recomputes freshness and profile consistency after generation. It checks
every reference, complete supporting profile, weather condition and claimed comparison. It rejects
duplicate, invented, stale or conflicting references and contradictory categories. The labelled
comparison tolerances are 0.5 °C for similar temperatures and one percentage point for similar
relative humidity. These are advisory comparison heuristics, not user preferences or universal
comfort limits. Relative humidity alone cannot establish absolute moisture or a ventilation benefit.

Categories include temperature/humidity comparison, weather caution, ventilation review and
comfort-preferences review. A ventilation review requires warmer indoor air and a current sunny,
clear-night, cloudy or partlycloudy condition; these conditions do not prove safe ventilation or
dry air. Other weather conditions may instead support caution when indoors is warmer. Similar
temperatures cannot support a cooling ventilation review. All review output explicitly requires
additional context such as comfort preferences, intent, window safety and outdoor air quality.
It recommends reviewing options, never opening a window or controlling heating/fans.

Accepted output uses application-owned explanations and verified structured facts, not model
prose. Every outcome has `executionAuthority: none` and no executable recommendations. Unknown
preferences do not prevent an insight, but interpreting conditions as comfortable/uncomfortable
requires a later explicit preference design. No preference storage or automatic approval is added.

The existing 16-observation complete-selection cap, 24,576-byte maximum full request including
4,096 bytes of response headroom, response limit, transport timeout and one-call maximum remain.
Requests never silently trim evidence. No model retries or extra inference calls are introduced.
Output remains private household data: sanitize it before sharing. Existing lighting comparisons,
readiness, authorization, dispatch, DRY_RUN and the instruction-driven illuminance guard are unchanged.
