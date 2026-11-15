# ARYAL — Development Roadmap

**Status:** Approved delivery direction, 15 November 2026. Dates are intentionally not promised. Milestones are gated by evidence and working user experience, not PR counts.

## Current baseline (verified against GitHub, 15 November 2026)

- `main` includes merged PRs **#1–#17**, through the explicitly invoked advisory assessment foundation.
- **PR #18** (multi-source environmental comfort assessment) is **open, unmerged**, at commit `fa06e67`. Its branch reportedly passes **1,609 tests across 49 files**; this is the PR's reported validation, not an independently rerun build here.
- Existing foundations: local Ollama structured reasoning, deterministic policy, relevance selection, validation, controlled explicit light/switch execution, Home Assistant data/metadata audit, lighting and threshold utilities, historical lighting analysis, and explicit advisory lighting/environmental assessment.
- Current user-facing gaps: no proactive situation engine, scheduled briefings, Home Assistant insights UI/feedback, category-based push routing, confirmation-led pattern learning, or approved autonomous behaviours.
- PR #18 live trial showed Home Assistant REST `/api/states` can expose older `last_reported` values than the read-only template rendering endpoint for unchanged Tuya readings. Weather was separately beyond the trial advisory window. Evidence-gating correctly skipped inference. Workaround and ADR were planned but **not implemented** as of this checkpoint.

## Milestone 0 — Finish and stabilise environmental evidence (PR #18)

**Outcome:** Reliable, honest advisory environmental assessments; no execution changes.

- Document the Home Assistant `last_reported` REST/template discrepancy and decision as an ADR, including upstream reference, extra-request/snapshot risks, feature boundaries and removal criteria.
- Implement only the narrowly scoped, validated, policy-filtered read-only timestamp retrieval needed. Match entity identity and values between snapshots; fail closed on inconsistencies. Do not create an unrestricted template or service-call capability.
- Keep indoor-reporting and weather-update windows independently configurable. Evaluate real observed reporting patterns; don't loosen windows just to force a positive result.
- Complete a positive live environmental assessment and negative/stale-evidence checks. Confirm `executionAuthority: none`, model input redaction, test results and no unauthorized HA writes.
- Review and merge PR #18 after evidence confirms the correction.

**Exit:** A valid live assessment or a reproducible, documented source-unavailability outcome; targeted and full regression tests; accepted ADR and merge review.

## Milestone 1 — First Home Intelligence product demonstration (A + C + D)

This is the **first major product milestone**. Implement in two incremental slices, but it is complete only when both situational intelligence **and proactive Home Assistant delivery** work together.

### Slice 1A — Reusable situational intelligence

- Define a compact typed **situation candidate** (category, area/whole-home scope, relevant source refs, timestamp, evidence status, change/relevance reason).
- Extend existing collectors carefully rather than creating another broad collection framework. Reuse policy resolution, registry membership, freshness provenance, evidence selection and validated snapshots.
- Use cheap deterministic screening on meaningful changes and bounded scheduled checks. Only qualifying candidates call the local model. Do not send all household data on every event.
- Produce a structured `insight | recommendation | no_action | insufficient_context` result, with deterministic factual validation, rationale/evidence for the user, and no executable command.
- Demonstrate three vertical scenarios:
  - **A Environmental comfort:** Indoor + outdoor + time/presence where relevant; explain conditional opportunity without asserting comfort preferences or physical freshness not proven.
  - **C Lighting/activity:** Lux + light status + time + usable presence/preferences where relevant; distinguish a useful recommendation from a predictable or unwanted suggestion.
  - **D Whole-home overview:** Select and prioritise notable situations across rooms. Prefer a concise overview over listing every entity; correctly report 'nothing needs attention'.
- Use sanitised fixture evaluations for good insight, irrelevant candidate, missing source, contradictory evidence and meaningful no-action outcomes.

**Slice 1A exit:** Each A/C/D scenario yields at least one defensible cross-source insight under supporting data; poor or missing evidence produces a safe no-action/uncertain outcome; decision traces show which facts supported what.

### Slice 1B — Proactivity and Home Assistant-native user experience

- Provide a bounded **scheduled briefing** and a bounded **event-driven assessment** path, with rate limits, deduplication, cooldowns, quiet hours and observable failure handling.
- Build a minimal Home Assistant integration surface for **insight feed, status, configuration and feedback**. Home Assistant is the only planned UI; no ARYAL-hosted standalone dashboard.
- Use Home Assistant notifications with **per-category explicit destination allowlists**. No recipients by default, no broad broadcasting, no new-device auto-enrolment, and no silent fallback to different recipients.
- Apply deterministic notification eligibility and routing after validated insight generation; the model never sets destination addresses.
- Separate dashboard-visible insights from interruption-worthy notifications; honour schedule, quiet hours, sensitivity and suppression settings.
- Allow feedback `useful`, `not useful`, `incorrect`; store locally for evaluation, **not** as implicit preference or action permission.
- Start with the user connecting an **existing local Ollama** instance. Keep engine local and small-model friendly.
- Provide essential everyday controls within Home Assistant, aiming to minimise CLI configuration, without prematurely building a general installer or complex standalone UI.

**Slice 1B exit:** A meaningful situation is noticed without a manual CLI request, shown in Home Assistant, optionally pushed to only the chosen destination(s), and can be marked useful/incorrect. Repeated non-events do not flood the user or model. No autonomous device execution.

### Milestone 1 acceptance gate

- A, C and D demonstrated end-to-end; each tested with supporting, missing and conflicting evidence.
- At least one scheduled and one event-triggered path demonstrated, with no-action and duplicate suppression.
- Insight history and feedback accessible inside Home Assistant.
- Device-category permissions independently tested, including no configured device and a newly discovered device.
- Full safety regression suite, privacy checks and bounded local model benchmarks pass.
- Review examples for factual accuracy, situational relevance and actual usefulness before declaring the milestone complete.

## Milestone 2 — Confirmation-led learning and personalisation

**Outcome:** ARYAL finds possible household routines and asks before treating them as preferences.

- Collect only permissioned, appropriately retained history; distinguish direct observations from inferred routines.
- Propose candidate patterns with evidence coverage and uncertainty; ask for user confirmation via Home Assistant.
- Store confirmed preferences separately from tentative patterns and separately from action permissions.
- Provide review/edit/forget controls; do not silently activate inferred thresholds or automations.
- Validate with cases that look regular but are misleading, including conflicting behaviour and sparse history.

**Exit:** A user can inspect, accept, reject, edit or remove a proposed pattern. Rejection prevents treating it as established fact.

## Milestone 3 — Explicitly opted-in low-risk autonomy

**Outcome:** ARYAL may choose *when* to exercise a specific approved capability, never *what it may authorise*.

- Define narrowly scoped low-risk capability grants, allowed devices/actions, contextual preconditions, time bounds and revocation.
- Introduce approval for newly proposed behaviours; no grant from an insight, learned pattern or model suggestion alone.
- Revalidate source evidence and policy immediately before dispatch; use existing hardened execution foundations only where applicable.
- Provide preview/audit/disable controls through Home Assistant. Critical infrastructure, locks and other restricted actions remain out of scope.

**Exit:** Demonstrated automatic execution is bounded, observable, reversible where appropriate, and rejects changed or missing conditions. Revocation takes effect before the next action.

## Milestone 4 — Broader personal intelligence and optional integrations

- **Calendar + tomorrow briefing:** Match explicit events to relevant weather and approved routines; suggest preparation without guessing personal plans.
- **Transport later:** Optional external journey APIs, real departure information and service disruptions; verify source freshness, route identity and user opt-in.
- **Energy intelligence later:** Device usage, tariffs and saving sessions as optional, separately validated sources; no automatic switching without later approved capabilities.
- **Assisted model setup:** Explore a Home Assistant-managed local Ollama/model experience without requiring it for installations with existing servers.
- **Continuous adaptive learning (later):** Maintain tentative patterns automatically and recognise drift, but require approval for changes to confirmed preferences or action authority.

**Exit:** Each added source increases useful contextual understanding without requiring a new standalone application or bypassing the same evidence/safety architecture.

## Work explicitly deferred

- A separate ARYAL web dashboard (not planned; only reconsider for clear compelling benefit).
- Unrestricted autonomous home control, cloud LLM dependencies or unsupervised action authority.
- A generic integration/plugin framework, knowledge graph or vector database without a concrete proven need.
- Learning user preferences solely from low-quality provenance signals.
- Background polling of every sensor or calling Ollama on every change.
- Full transport, calendar, energy, managed Ollama and continuous adaptive learning in the first Home Intelligence release.

## Evaluation, scope control and review

Every feature/PR should answer: Which user situation does it improve? What evidence is required? What happens when evidence is missing? Why is a small model useful? What deterministic checks remain authoritative? How will a real user judge the result? How does it affect notifications, privacy and performance?

Do not equate a growing test count or number of sensors with product intelligence. Establish measurable baselines for factual accuracy, false positives, user usefulness, model calls per day, latency, memory use and notification volume using real pilot trials and test fixtures. Declare milestone success only after a real Home Assistant demonstration.

**Next work item:** Complete the PR #18 timestamp workaround + ADR and the positive/negative live assessment, then begin Milestone 1A by designing a small reusable situation-candidate contract and three A/C/D acceptance scenarios.