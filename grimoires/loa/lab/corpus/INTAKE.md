# Corpus intake (FR-5, bd-1vp7)

> Raw source material becomes governed corpus here. Nothing enters unscrubbed;
> nothing leaves raw (`internal-only` egress is citations/metadata via the
> shared refOnly discipline — SDD §4).

## The gate (per source, in order)

1. **Drop** the raw export into `intake/<source>/`.
2. **Scrub**: `npx tsx src/lab/shop/corpus-scrub.ts intake/<source>` — applies
   the flatline `secret_scanning` patterns (ONE pattern SoT), redacts in place,
   writes `manifest.yaml` (sha256 raw + redacted, redaction counts).
3. **Verify + delete raws**: check the manifest, then delete any unscrubbed
   copies — retention is redacted-only + manifest hashes (SDD 2.4).
4. **Stamp** `provenance.yaml`:
   ```yaml
   schema_version: 1
   source: <where this came from>
   acquired: <date>
   tier: git-verbatim | account-verbatim | captured | claimed
   privacy: internal-only
   guards: []   # misattribution guards — travel with every consultation citing this source
   ```
5. Third-party persons' content is minimized to what the corpus purpose needs.

## Operator-gated V1 items (open items narrow the corpus, never block)

| Item | Owner | Status | Evidence when done |
|---|---|---|---|
| Discord export (ERR-era channels + the 2026-05-04 custody-grant conversation) | operator | OPEN | `intake/discord-2026/manifest.yaml` |
| Custody-grant vault capture signed (one cockpit gesture) | operator | OPEN | vault frontmatter `operator_signed` |
| Dead `~/hivemind` symlink fixed in bonfire CLAUDE.md | operator | OPEN | pointer resolves to `~/Documents/GitHub/hivemind` |

Backlog (beads): the missing "Jester Arc" essay · `merlin/agentic-base.md` —
referenced-but-lost; recover if any copy surfaces.
