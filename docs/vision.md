# ARYAL — Product Vision v2

**Status:** Approved product direction, 15 November 2026. Implementation follows the phased [roadmap](roadmap.md).

## Purpose

ARYAL (**Adaptive Reasoning for Your Automated Living**) is a privacy-first, local personal intelligence system for Home Assistant users. It gathers permitted information from the home and, over time, other parts of everyday life, connects relevant facts, recognises meaningful situations, and provides useful, timely, evidence-backed insights and recommendations. Later, it may carry out low-risk actions within explicit user-approved boundaries.

**Product promise:** *ARYAL makes sense of scattered information so that users do not have to connect every dot themselves.*

ARYAL is **not primarily a natural-language remote control**, a chatbot attached to every entity, a general-purpose autonomous agent, or a collection of disconnected sensor summaries. Natural-language requests remain an optional interface.

## Initial product focus

**Home intelligence first.** The first major product milestone must demonstrate whole-home situational intelligence through three complementary scenarios:

1. **Environmental comfort (A):** Relate indoor temperature/humidity, outdoor conditions, time and permitted presence information to meaningful, conditional comfort insights. Do not invent comfort preferences, physical measurement freshness, safety conditions or user intent.
2. **Lighting and room activity (C):** Relate illuminance, lights, time, presence where supported, and approved preferences. Do not recommend actions just because a room is dark; context and usefulness matter.
3. **Whole-home overview (D):** Select and prioritise noteworthy information across rooms, distinguishing genuine opportunities from ordinary sensor readings. Include the valid outcome that nothing needs attention.

Energy intelligence is a **future capability**, not one of the initial three proof scenarios. After home intelligence, expand to calendar, tomorrow's preparation, weather, clothing suggestions, and later transport planning using appropriate external APIs. The motivating example is recognising a workday from a calendar and identifying relevant weather and journey information without a separate question for each source.

## How ARYAL should behave

- **Observe and understand:** Use configured, permitted context rather than assuming every available entity matters.
- **Proactively help:** Provide scheduled briefings and genuinely important event-driven insights without being asked each time.
- **Know when to be silent:** Reject unsupported conclusions, suppress unhelpful repetition, and avoid notification overload.
- **Explain:** State what was noticed, which evidence supports it, what is uncertain, and why a recommendation may help.
- **Learn progressively:** First identify patterns and ask permission to remember them as confirmed preferences. Later maintain provisional patterns continuously, while keeping confirmed preferences and authorised behaviour separately controlled.
- **Act only within authority:** After insights have proven trustworthy, permit selected low-risk actions inside previously approved scopes, with independent fresh checks. New behaviours require explicit approval before becoming enabled.

## Experience and distribution

- **Home Assistant is the only planned user interface.** Present insights, history, preferences, feedback, approval requests and configuration through Home Assistant. A standalone web UI is *not on the roadmap*; revisit only if compelling user value justifies it.
- **Notification delivery:** Use Home Assistant mobile notifications, with destinations chosen **explicitly per notification category** (important/time-sensitive, routine recommendation, briefing, learning/approval). New devices are not enrolled automatically. No configured destination means no push. The model never chooses recipients.
- **Dashboard versus interruptions:** Show validated relevant insights in Home Assistant. Push only according to category policy, urgency, importance, quiet hours and repeat suppression. Scheduled briefings follow user configuration.
- **Installation:** Target Home Assistant-native onboarding and routine configuration with minimal terminal or file editing. Advanced configuration may remain available. Packaging must support the different Home Assistant installation environments where feasible.
- **Model hosting:** First support a pre-existing **local Ollama** instance, including one running on another home-network machine. Explore assisted/managed local model setup later. Keep the engine model-agnostic where practical and capable of running small models on ordinary, memory-constrained consumer hardware.
- **Audience:** Anyone using Home Assistant who wants configurable, privacy-conscious intelligence. Generalise capabilities beyond a particular room or household. Support an intentionally limited set of high-quality capabilities rather than pretending to support everything.

## Core reasoning and authority architecture

```text
Permitted sources (HA states/history, weather, time, eventually calendar/transport/energy)
  -> source validation, normalisation, provenance and freshness
  -> deterministic relevance and candidate-situation selection
  -> compact, bounded snapshot for a local small model
  -> structured situation insight / recommendation / no-action proposal
  -> independent, evidence-grounded deterministic validation
  -> prioritisation, deduplication and user notification policy
  -> Home Assistant insights and explicitly routed notifications
  -> [future] separately approved behaviour + fresh authorisation + controlled execution
```

Models may **reason and propose**, not grant evidence, permissions or execution authority. Deterministic application code owns source exposure, deny precedence, snapshot constraints, evidence checks, relevance/notification eligibility, approvals, dispatch restrictions, fresh authorisation and confirmation. An approval is not an authorisation shortcut.

## Non-negotiable boundaries

1. **Local-first privacy:** Reasoning and personal memory are local. Data coming from user-permitted cloud-backed integrations does not authorise sending household information to a cloud AI provider. Never place secrets, real household inventory or installation identifiers in public code or examples.
2. **Default deny:** Only explicitly permitted, relevant sources are exposed. Deny overrides allow; registry and area membership are validated. Read permission never implies control permission.
3. **Evidence over fluency:** Sensor state changes, Home Assistant reporting activity and physical measurement time are distinct. Missing, stale, contradictory or uncertain information remains labelled; no invented facts, thresholds, occupancy, intent or preferences.
4. **Model independence from safety:** Structured output and deterministic post-model checks are mandatory. Neither model confidence nor persuasive prose grants authority.
5. **Small-model efficiency:** Use bounded context, deterministic screening before inference, limited model calls and local transport. Avoid unnecessary heavy frameworks or a vector database without clear benefit.
6. **Notifications are authorised outputs:** Explicit destination allowlists by category, no broadcast fallback, quiet hours and duplicate suppression. Avoid private details on lock screens where configured.
7. **Automatic action comes later:** No autonomous execution is introduced by the first Home Intelligence milestone. Subsequent low-risk automation requires per-capability opt-in, explicit boundaries, revalidation and auditability. Critical/unsafe actions remain disallowed.
8. **Human-readable and reversible:** Insights and tentative patterns should be reviewable; confirmed preferences and enabled behaviours must be editable, revocable and removable.

## Progressive learning model

- **Observation:** A time-scoped, provenance-labelled fact or event, not a preference.
- **Inferred pattern:** A tentative interpretation with supporting history and uncertainty. Initially shown as a confirmation request; it is not a trusted preference.
- **Confirmed preference:** What the user deliberately agrees to store. Does not itself authorise actions or notifications.
- **Authorised behaviour:** A separate explicit permission with scopes and limits, subject to fresh checks before each execution.

The first learning stage proposes patterns and stores preferences only after confirmation. A later stage may update provisional patterns automatically, but may not silently rewrite confirmed preferences or grant itself new behaviour permissions.

## What success looks like

A first useful Home Intelligence release should:

- Demonstrate **A, C and D** with realistic, permission-scoped, cross-source scenarios, including negative/no-insight cases.
- Produce at least one genuinely useful, evidence-backed recommendation for each scenario; merely echoing raw readings does not count.
- Handle unavailable or old sources without inventing facts or disabling unrelated insights.
- Run bounded scheduled and event-driven assessments; avoid repeated calls for unchanged uninteresting situations.
- Present results, provenance, explanation and feedback in Home Assistant; push only to the specifically authorised devices and categories.
- Operate with a local small model on ordinary consumer hardware and measured resource use.
- Make **zero unauthorised device-control requests**; automatic actions are out of scope for this milestone.

Use a small evaluation dataset of real, sanitised cases and synthetic regression cases to record factual correctness, usefulness, relevance, notification rate, false positives and no-action behaviour. Set numeric quality targets from an observed baseline rather than inventing guarantees.

## Feature decision filter

Prioritise work that improves cross-source situational understanding, trustworthy evidence, user usefulness, Home Assistant integration, local performance or later controlled autonomy. Prefer reusable capabilities and vertical end-to-end demonstrations. Defer new frameworks, integrations and device-specific edge cases unless they block a validated priority scenario. Maintain ADRs for significant technical trade-offs and update this vision only after deliberate product decisions.