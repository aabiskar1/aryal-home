# ARYAL — Architecture Decision Register

**Status:** Product decisions approved on 15 November 2026; technical ADR candidates below remain proposals until individually reviewed. IDs are provisional and should follow the repository's ADR numbering convention.

## Agreed product decisions reflected in `docs/vision.md`

| Decision | Agreed direction |
| --- | --- |
| Purpose | Local, privacy-first personal intelligence that connects scattered facts and gives useful, grounded insights |
| First focus | Whole-home intelligence, with A environmental comfort, C lighting/activity, D whole-home overview |
| UX | Home Assistant only; standalone UI not planned unless later evidence justifies it |
| Communication | Scheduled briefings and important event-driven insights; dashboard for non-urgent results |
| Push destinations | Explicit, category-specific devices; no recipients by default and no broadcast |
| Initial autonomy | Insights and proactive recommendations only; no automatic actions in first Home Intelligence milestone |
| Later autonomy | Intelligent decisions within previously approved bounds; proposed new behaviours require approval |
| Learning | Initially suggest inferred patterns for confirmation; continuously adaptive tentative learning later |
| Installation | Home Assistant-native configuration, minimal setup effort |
| Model hosting | Existing local Ollama first; assisted/managed model installation later |
| Audience | Configurable, reusable open-source system for other HA households |
| Future sources | Calendar/tomorrow briefings, later transport, energy and other opt-in sources |

## ADR candidates

### ADR-001 — Trustworthy Home Assistant reporting timestamps (immediate, PR #18)

**Observed problem:** On HA Core 2026.10.4, direct REST reads returned `last_reported` values older than those from live Jinja templates for unchanged Tuya temperature/humidity sensors. Confirmed with `GET /api/states`, `GET /api/states/{id}` and a read-only `POST /api/template` render. Link to upstream Home Assistant issue #180917 after independently checking its current status.

**Proposed temporary decision:** Retain REST for state values/attributes, and use a narrowly scoped, policy-filtered template-rendered reporting-timestamp snapshot only when necessary, with strict entity identity/value/update-time consistency validation and fail-closed handling. No service-call permission or general Jinja execution facility.

**Removal trigger:** Re-test on a future Home Assistant release across repeated unchanged sensor reports; when REST consistently supplies correct reporting times, remove the workaround and its complexity. Document how it was verified. **The actual ADR and workaround have not yet been committed.**

### ADR-002 — Home Assistant-native integration and engine packaging (before Milestone 1B)

**Question:** What lightweight deployment contract supports an HA-only interface, existing local Ollama servers and the TypeScript engine across HA installation types?

**Options to evaluate:** HA custom integration plus separately hosted engine, optionally HA-managed App where supported. Preserve one user interface, local transport and secure configuration. Do not prematurely mandate an HA App for every installation.

### ADR-003 — Situation detection and efficient local inference (before Milestone 1A)

**Question:** How are bounded scheduled checks and selected HA events converted into evidence-driven situation candidates without running the model for every update?

**Decision criteria:** Source-policy enforcement, area/whole-home scope, relevance, bounded request budgets, deterministic preflight, no-action behaviour, duplicate suppression, testable trigger semantics and modest hardware use.

### ADR-004 — Insight lifecycle, dashboard representation and data retention (before Milestone 1B)

**Question:** Where are validated insights, their evidence summaries, feedback and notification status kept so Home Assistant can show them safely?

**Decision criteria:** Local storage, privacy, retention limits, inspectability, correctness updates, no untrusted raw model rationale, no unnecessary full home-state history.

### ADR-005 — Explicit notification routing and interruption policy (before Milestone 1B)

**Decision:** Destinations are per-category, explicitly configured, deny-by-default and checked by deterministic application logic; model cannot choose endpoints. Review HA notification service handling, unavailable devices, quiet hours, scheduling, deduplication and sensitive message content.

### ADR-006 — Pattern provenance and confirmed preferences (before Milestone 2)

**Decision:** Historical observations, tentative inferred patterns, approved preferences and behavioural authorisations are separate records and trust levels. No implicit preference write, no implicit capability approval. Review data retention and edit/revoke semantics.

### ADR-007 — Approved low-risk actions (before Milestone 3)

**Question:** Which capability-scoped grants, fresh checks, rate limits, action audits and revocation flows make adaptive low-risk execution safe? Keep existing execution authority boundaries; no inference-based grants.

## Documentation governance

- `docs/vision.md` is the durable **product goal** and guardrails.
- `docs/roadmap.md` is the changeable **delivery plan**, with current status and acceptance gates.
- `docs/adr/` (if adopted) holds **technical trade-offs and reversal/removal criteria**.
- `AGENTS.md` tells coding assistants to read these documents and protect the invariants; it must be updated after vision/roadmap approval, not before.
- `.codex/checkpoint.md` is a private, local **development state**, not the canonical product vision.
- Neither chat memory nor inferred user preferences supersedes the agreed repository documents.