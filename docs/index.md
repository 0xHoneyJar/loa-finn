<!-- AGENT-CONTEXT: name=documentation-index, type=overview, purpose=Central navigation hub for all Finn documentation, key_files=[src/index.ts], interfaces=[], dependencies=[], version=8d60958b2aa46facc5298b0f73252c084b74943e -->

# Finn Documentation

<!-- provenance: OPERATIONAL -->
Central index for all Finn project documentation. Each document is generated from source code using the ground-truth pipeline with provenance tagging and quality gate verification.

## Quick Links

<!-- provenance: OPERATIONAL -->
| Need | Document |
|------|----------|
| Getting started | [README](../README.md) |
| System design | [Architecture](architecture.md) |
| API endpoints | [API Reference](api-reference.md) |
| Deployment | [Operations](operations.md) |
| Security posture | [Security Policy](../SECURITY.md) |

## Core Documentation

<!-- provenance: OPERATIONAL -->
| Document | Description | Location |
|----------|-------------|----------|
| [README](../README.md) | Project overview, capabilities, quick start | Root |
| [Architecture](architecture.md) | 5-layer system architecture, component interactions | docs/ |
| [Operations](operations.md) | Deployment modes, environment variables, health checks | docs/ |
| [API Reference](api-reference.md) | HTTP/WebSocket endpoints, authentication, error codes | docs/ |

## Module Documentation

<!-- provenance: OPERATIONAL -->
Detailed documentation for each major subsystem:

<!-- provenance: OPERATIONAL -->
| Module | Description | Location |
|--------|-------------|----------|
| [Gateway](modules/gateway.md) | HTTP and WebSocket API server | docs/modules/ |
| [Hounfour](modules/hounfour.md) | Multi-model orchestration engine | docs/modules/ |
| [Persistence](modules/persistence.md) | WAL, R2 sync, Git backup | docs/modules/ |
| [Cron](modules/cron.md) | Scheduled job system | docs/modules/ |
| [Safety](modules/safety.md) | Audit trail, tool registry, firewall | docs/modules/ |
| [Agent](modules/agent.md) | Session management and sandbox | docs/modules/ |
| [BridgeBuilder](modules/bridgebuilder.md) | PR automation pipeline | docs/modules/ |
| [Scheduler](modules/scheduler.md) | Periodic task management | docs/modules/ |

## Governance Documentation

<!-- provenance: OPERATIONAL -->
| Document | Description | Location |
|----------|-------------|----------|
| [Security Policy](../SECURITY.md) | Security architecture, vulnerability reporting | Root |
| [Contributing Guide](../CONTRIBUTING.md) | Dev setup, workflow, code standards | Root |
| [Changelog](../CHANGELOG.md) | Version history and release notes | Root |

## Framework Documentation

<!-- provenance: OPERATIONAL -->
These documents describe the Loa development framework, not the Finn application:

<!-- provenance: OPERATIONAL -->
| Document | Description |
|----------|-------------|
| [Development Process](../PROCESS.md) | Loa agent-driven workflow |
| [Installation Guide](../INSTALLATION.md) | Loa framework setup |

## Archived Documentation

<!-- provenance: OPERATIONAL -->
Previous documentation is preserved in [docs/archive/](archive/) for historical reference. Archived content is not maintained and may be outdated.

## Document Quality

<!-- provenance: OPERATIONAL -->
All documents in this index pass the ground-truth quality gate pipeline:

<!-- provenance: OPERATIONAL -->
1. **AGENT-CONTEXT** — structured metadata for AI consumption
2. **Citation verification** — all `file:line` references resolve to real code
3. **Provenance tagging** — every paragraph tagged with source classification
4. **Claim grounding** — no unverified factual claims
5. **Security scanning** — no credentials or secrets in documentation
6. **Link checking** — all relative links resolve
7. **Freshness tracking** — document age vs HEAD SHA

<!-- provenance: OPERATIONAL -->
Run verification: `bash .claude/scripts/ground-truth/quality-gates.sh <doc> --json`
