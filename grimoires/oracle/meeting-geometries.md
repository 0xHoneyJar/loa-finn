---
generated_date: "2026-02-16"
source_repo: 0xHoneyJar/loa-finn
provenance: cycle-025-sprint-61-task-2.5
version: "1.0.0"
rfc_reference: "loa#247"
---

# Meeting Geometries — AI-Human Collaboration Patterns

Eight configurations for AI-human collaboration, defined in RFC loa#247. Each geometry describes a spatial and relational arrangement for how agents and humans interact. The geometries provide a vocabulary for designing agent interaction patterns with intentionality — the shape of the interaction determines the shape of the output.

## The 8 Geometries

### 1. Circle of Equals

All participants contribute without hierarchy. No single voice dominates. Ideas flow freely between human and AI participants, each building on the other's contributions. The Circle geometry produces exploratory, creative output where the origin of an idea matters less than its quality.

**Pattern**: Multi-directional, non-hierarchical dialogue.
**When to use**: Brainstorming, vision alignment, philosophical exploration.
**Example in ecosystem**: Early design sessions where human and AI iterate on product vision.

### 2. Master-Apprentice Pair

One leads, one learns — but the direction is explicitly bidirectional. Sometimes the human teaches the AI about regulatory constraints or domain expertise; sometimes the AI teaches the human about codebase patterns or architectural history. The direction depends on domain expertise, not on species.

**Pattern**: Directed knowledge transfer with role flexibility.
**When to use**: Onboarding, teaching, deep domain exploration.
**Example in ecosystem**: The Oracle itself implements this geometry — teaching ecosystem knowledge to questioners while learning from the questions asked.

### 3. Constellation

Multiple specialized agents collaborate with human oversight. Each agent brings a different capability or perspective. The human orchestrates, directing attention and synthesizing across agent outputs. Like stars forming a recognizable pattern, the individual agents create something coherent only when seen together.

**Pattern**: Hub-and-spoke with human at center.
**When to use**: Complex multi-domain tasks requiring diverse expertise.
**Example in ecosystem**: The Hounfour multi-model router enabling different models for different task types.

### 4. Solo with Witnesses

One agent works while others observe and may comment but do not intervene directly. The witnesses provide accountability and a different perspective on the work product. The primary agent operates with full autonomy within its domain; witnesses catch what the soloist might miss.

**Pattern**: Primary actor with passive observers.
**When to use**: Focused implementation with peer review.
**Example in ecosystem**: Run Mode autonomous sprints where implementation proceeds with review and audit gates.

### 5. Council

Multiple agents deliberate and present perspectives, but the human retains final decision authority. The agents may disagree with each other — that disagreement is valuable signal, not a failure state. The Council geometry explicitly separates deliberation from decision.

**Pattern**: Multi-voice deliberation with human authority.
**When to use**: Architectural decisions, risk assessment, trade-off analysis.
**Example in ecosystem**: The Flatline Protocol — Opus and GPT-5.2 cross-score findings, but humans decide on DISPUTED and BLOCKER items.

### 6. Relay

Sequential handoff between agents, each adding their specialized contribution before passing to the next. Order matters — each agent builds on what the previous agent produced. The Relay geometry creates a pipeline where quality compounds through stages.

**Pattern**: Sequential, stage-based handoff.
**When to use**: Multi-phase workflows, document refinement, progressive enhancement.
**Example in ecosystem**: The simstim workflow — PRD creation hands off to architecture, which hands off to sprint planning, which hands off to implementation.

### 7. Mirror

AI reflects human work from a different perspective. The Mirror does not replicate — it reveals what the original cannot see about itself. A code review is a mirror; a philosophical analysis of technical decisions is a mirror; a bridgebuilder report that finds Ostrom's governance principles in a retry strategy is a mirror.

**Pattern**: Reflective analysis from an alternate viewpoint.
**When to use**: Code review, architectural critique, philosophical grounding.
**Example in ecosystem**: The Bridgebuilder review model — reflecting code changes through architectural, educational, and philosophical lenses simultaneously.

### 8. Swarm

Many agents work in parallel on decomposed tasks. The human sets direction and constraints; the agents self-organize within those boundaries. The Swarm geometry maximizes throughput at the cost of coordination overhead. Works best when tasks are independently decomposable.

**Pattern**: Parallel execution with shared constraints.
**When to use**: Large-scale implementation, parallel exploration, comprehensive analysis.
**Example in ecosystem**: Agent Teams mode (Loa v1.39.0) — multiple agents working on sprint tasks simultaneously with a team lead coordinating.

## Design Principles

### Geometry as Configuration, Not Code

Meeting geometries are described as configurations — patterns of interaction — rather than code implementations. Any tool or workflow can implement a geometry by following the interaction pattern. This makes geometries composable: a Constellation can include Master-Apprentice Pairs as sub-interactions. A Swarm can contain Councils for decisions within parallel streams.

### Human Agency Preserved

Every geometry preserves human agency. Even in the Swarm (maximum AI autonomy), humans retain the ability to halt, redirect, or override. The Council explicitly places final decision authority with the human participant, even when multiple AI agents have deliberated. This is not a limitation — it is a design constraint that produces better outcomes.

### Directionality Matters

The spatial metaphor is intentional. Circle implies equality. Master-Apprentice implies directed knowledge flow. Council implies deliberation before decision. The name of the geometry communicates its interaction pattern, making it easier to choose the right geometry for a given situation.

## Connection to the Ecosystem

Meeting geometries provide the conceptual vocabulary for all agent interaction design in the HoneyJar ecosystem:

| Ecosystem Feature | Geometry | Rationale |
|---|---|---|
| Bridgebuilder Review | Mirror | Reflects code through multiple lenses |
| Flatline Protocol | Council | Multi-model deliberation with human authority |
| Simstim Workflow | Relay | Sequential phase handoff |
| Agent Teams | Swarm | Parallel task execution |
| Oracle | Master-Apprentice | Bidirectional knowledge transfer |
| Run Bridge | Mirror + Relay | Iterative reflection with sequential improvement |

## Industry Parallel

Meeting geometries parallel organizational design patterns in management theory. Conway's Law states that system architecture mirrors organizational communication structure. Meeting geometries extend this insight to AI-human collaboration: the shape of the interaction determines the shape of the output.

The deliberate choice of geometry — rather than defaulting to a single interaction pattern — is analogous to how mature engineering organizations choose between pair programming, code review, design review, and mob programming based on the nature of the problem. No single pattern is universally optimal.

## Philosophical Foundation

The meeting geometries emerge from a recognition that collaboration is not a binary (human does it vs. AI does it) but a spectrum of possible arrangements. Each geometry represents a different balance of agency, expertise, oversight, and creativity. The taxonomy makes these arrangements explicit and nameable, turning implicit interaction patterns into conscious design choices.

This connects to the broader web4 vision: just as monetary pluralism recognizes that different communities need different currencies, collaboration pluralism recognizes that different tasks need different interaction geometries. The goal is not to find the one best way to work with AI, but to develop fluency in choosing among many ways.
