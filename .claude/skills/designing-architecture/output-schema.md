# Output Schema: System Design Document

## Expected Format

```markdown
# System Design Document: [Project/Feature Name]

## Executive Summary

[2-3 sentences: what is being built, why, and the key architectural approach]

## System Architecture

[High-level architecture description with ASCII or Mermaid diagram]

## Technology Stack

| Layer | Technology | Justification |
|-------|-----------|---------------|
| Runtime | [e.g., Node.js] | [Why this choice] |
| Database | [e.g., SQLite] | [Why this choice] |
| [etc.] | | |

## Component Design

### [Component Name]

**Responsibility**: [Single sentence]
**Interface**: [Public API surface]
**Dependencies**: [What it depends on]
**Key decisions**: [Tradeoffs made]

[Repeat for each component]

## Data Architecture

[Data models, schemas, relationships, migration strategy]

## API Design

[Endpoints, contracts, versioning strategy]

## Security Architecture

[Auth model, data protection, input validation, threat model]

## Deployment Architecture

[How it runs, infrastructure, scaling, monitoring]
```

## Constraints

- Executive Summary is mandatory and must not exceed 3 sentences
- Every component must have Responsibility, Interface, and Dependencies
- Technology Stack must include justification for each choice
- Security Architecture section is required, never omitted
