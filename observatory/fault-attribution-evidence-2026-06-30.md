# Fault‑Attribution Evidence Packet — 2026‑06‑30

This document defines a **long‑horizon fault‑attribution evidence packet** for use in Loa‑Finn experiments.  It is inspired by the *SAFARI* diagnostic framework for agentic fault attribution and the *Always‑OnAgents* survey of persistent state and governance.  The goal is to give Finn a repeatable way to record why an experiment failed without collapsing the proof into a free‑form narrative or an LLM‑judged summary.

## Purpose

Persistent agent failures are often diagnosed by dumping entire execution traces into an LLM and asking for an explanation.  This approach is incompatible with Finn’s determinism requirement and with reproducible evidence.  A fault‑attribution packet:

- identifies the precise segment of a long trajectory where the fault occurred;
- records enough metadata to reproduce and replay that segment deterministically;
- ties the segment back to actors, actions and cost records; and
- avoids using an LLM as the final judge of correctness.

## Required fields

| Field | Description |
|---|---|
| **Trajectory segment index** | A stable identifier for the segment of the experiment timeline under investigation.  Use zero‑based indexing; segments should be contiguous and anchored to WAL entries. |
| **Fault timestamp/window** | The wall‑clock time (ISO 8601) or experiment iteration range when the anomaly was observed. |
| **Actor IDs** | Stable identifiers (e.g. public keys or internal IDs) for the agents or subsystems involved in the segment.  Include all participants, not only the one believed to have erred. |
| **Action IDs** | Identifiers for the calls/actions executed during the segment.  These should correspond to deterministic WAL entries. |
| **WAL/audit links** | Pointers to the write‑ahead log entries, audit records and hash‑chained checkpoints covering the segment.  Links should be permanent (e.g. object store URIs) and include content hashes. |
| **Replay command** | A command or script snippet that reproduces the segment using the recorded WAL and state.  It must not invoke an LLM or any external non‑deterministic service. |
| **Cost record pointer** | The location of cost/billing records associated with the segment.  If the segment did not incur cost, record the absence explicitly. |
| **Settlement rule** | A description of how the experiment will decide whether the fault is *held*, *falsified* or *insufficient*.  This rule must be deterministic and must not defer the decision to an LLM. |

## Usage guidance

1. **Register before execution**.  Finn experiments must be registered before they run.  Define a maximum trajectory length and a maximum number of segments that will be investigated.
2. **Capture during execution**.  When a failure is suspected, extract the relevant segment using the WAL/audit chain rather than copying random log lines.  Do not truncate or summarise; include full identifiers and hashes.
3. **Review deterministically**.  Use deterministic tools (e.g. diff, hash comparison) to evaluate whether the fault reproduces.  Only if the segment reproduces under identical conditions should it be considered *held*.
4. **Avoid LLM judgement**.  LLMs may assist in describing evidence but must not determine the verdict.  The settlement rule should specify factual conditions (e.g. “the replay reproduces the missing file write within ±5 ms”) rather than subjective quality measures.
5. **Link to upstream documents**.  Cite the *SAFARI* paper for active investigation methodology and the *Always‑OnAgents* survey for state governance axes.  When deriving future experiments from this packet, include those sources in the claim ledger.

## Attribution and references

- **SAFARI: Scaling Long Horizon Agentic Fault Attribution via Active Investigation** (arXiv:2606.24626) proposes investigating fault segments instead of dumping full traces.  It emphasises reproducibility and segment search over context length.
- **Always‑OnAgents: Persistent Memory, State and Governance in LLM Agents** (arXiv:2606.30306) defines axes for evaluating state items—authority, scope, mutability, provenance, recoverability and actionability—which should inform how WAL and audit entries are named and reasoned about.

Use this template whenever Finn needs to diagnose a long‑horizon failure.  It should be stored in the repository under `observatory/` or a similar docs directory and linked from the daily research reports and decision artefacts.
