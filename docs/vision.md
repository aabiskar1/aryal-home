# ARYAL vision

ARYAL (Adaptive Reasoning for Your Automated Living) is a privacy-first, local AI
orchestration system for ordinary consumer hardware. Its purpose is to gather useful
context, help a small local model reason about a situation, and produce useful
recommendations within user-controlled safety boundaries. Home Assistant remains the
source of truth for home state. Natural-language requests are one optional interface;
they are not the architectural centre of the project.

The direction is:

```text
Context sources → validation and normalization → relevant compact snapshot
  → local AI reasoning → structured proposals → deterministic recommendation checks
  → recommendation → explicit approval where appropriate
  → independent fresh authorization → controlled execution and confirmation
```

Reasoning asks what could be useful. Recommendation validation checks the evidence,
preferences, scope and supported actions. Approval records a user's decision; it does
not replace authorization. Authorization independently determines whether an action
may execute now. Execution owns service routing, dispatch and confirmation. The model
proposes; deterministic application code controls every permission and execution gate.
Model confidence and generated prose are never evidence or authority.

Context can eventually come from Home Assistant, calendars, presence/location,
weather, energy, schedules and explicitly approved preferences. These are directions,
not a claim that every source is implemented. Each source needs clear provenance,
availability, relevance and freshness semantics. Missing evidence remains unknown;
time or weather must not invent a sensor measurement or someone's intent.

Keep household data local, expose only relevant permitted normalized information,
and avoid unnecessary model calls and large prompts. Prefer bounded snapshots,
simple integrations and predictable resource use over frameworks, vector stores or
cloud AI dependencies. Designs must remain practical for CPU-only small models and
memory-constrained machines.

Move progressively from explicitly invoked assessments towards approved triggers,
notifications, approval workflows and controlled proactive assistance. Proactivity
does not grant unrestricted autonomous control. Read-only assessment, approval,
authorization and execution must remain distinct as the system grows.

Feature proposals should improve context gathering, reasoning, useful recommendations,
integration or controlled execution; be reusable beyond one room/device; maintain
local-first privacy and small-model efficiency; preserve deterministic safety; and
avoid complexity that the current milestone does not need.
