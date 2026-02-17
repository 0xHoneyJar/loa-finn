---
id: naming-mythology
type: knowledge-source
format: markdown
tags: [philosophical]
priority: 17
provenance:
  source_repo: 0xHoneyJar/loa-finn
  generated_date: "2026-02-17"
  description: "Naming conventions and mythological references"
max_age_days: 180
---

# Naming & Mythology

## The Vodou Computing Metaphor

The ecosystem draws its naming from Haitian Vodou, creating a consistent metaphorical framework for distributed computing concepts.

### Core Terms

**Loa** (noun): In Vodou, a spirit or intermediary between the human world and the divine. In our system, Loa is the development framework — the intermediary between developer intent and running code. "The Loa rides through the code, channeling truth into the grimoire."

**Hounfour** (noun): The Vodou temple or sacred meeting place. In our system, the multi-model provider abstraction — the place where different AI models (spirits) are invoked and orchestrated.

**Péristyle** (noun): The covered area of the Hounfour where ceremonies take place. In our system, the public interface or API layer — the visible surface where external requests are received.

**Cheval** (noun, "horse"): In Vodou, the person who is "ridden" (possessed) by a Loa during a ceremony. In our system, the adapter pattern — the runtime that "carries" the AI model. `cheval.py` is the Python sidecar that hosts self-hosted models.

**Grimoire** (noun): A book of magic or spells. In our system, the state directory containing knowledge, configuration, and accumulated wisdom. `grimoires/oracle/` holds the Oracle's knowledge base.

### System Names

**Finn** (proper noun): The loa-finn gateway. Named after Finn McCool (Fionn mac Cumhaill) of Irish mythology — a warrior-poet who gained wisdom by tasting the Salmon of Knowledge. Appropriate for a gateway that routes to models of knowledge.

**Arrakis** (proper noun): The infrastructure layer. Named after the desert planet in Frank Herbert's Dune — the source of the valuable "spice" that enables interstellar travel. In our system, arrakis is the source of the billing "spice" that enables the economic model.

**Dixie** (proper noun): The Oracle frontend (loa-dixie). The public face of the Oracle knowledge interface.

**Mibera** (proper noun): The economic theory framework. Derived from "mi" (many) + "bera" (value) — representing monetary pluralism where multiple forms of value coexist.

### Operational Terms

**Jack In / Jack Out**: Start/stop autonomous execution (from William Gibson's Neuromancer). `.run/` state transitions: `RUNNING` → `JACKED_OUT`.

**Simstim**: Human-in-the-loop execution mode. From Gibson: "simulated stimulation" — experiencing the AI's work while maintaining your own consciousness.

**Flatline**: Convergence detection in iterative review. When the BridgeBuilder finds no new issues, the bridge has "flatlined" (also a Neuromancer reference — the AI construct named Dixie Flatline).

**BridgeBuilder**: The review agent persona. Builds bridges between code quality and production readiness through iterative improvement.

**Spice Gate**: The arrakis billing settlement system. Named for the "spice" (melange) gateways in Dune that control access to the most valuable resource.
