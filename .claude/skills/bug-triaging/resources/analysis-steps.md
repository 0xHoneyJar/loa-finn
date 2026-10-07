# bug-triaging Phase-3 analysis steps (cycle-121 split from SKILL.md)

Execute EXACTLY as written during codebase analysis.

### Analysis Steps

```
1. Parse stack traces → extract file:line references
   - Use Grep to verify file:line references exist
   - Extract function/method names from stack frames

2. Keyword search: search codebase for function/module names from error
   - Use Grep with function names, error messages, class names
   - Limit to relevant source directories (src/, lib/, app/)

3. Dependency mapping: trace imports/requires from affected files
   - Read suspected files
   - Follow import chains 1-2 levels deep
   - Note shared dependencies

4. Test discovery: find test files matching affected modules
   - Glob for test files: **/*.test.*, **/*.spec.*, **/test_*.*, **/*_test.*
   - Match test files to suspected source files by name/path

5. Test infrastructure detection:
   - Search for test runners:
     | Runner | Detection |
     |--------|-----------|
     | jest | package.json "jest" or jest.config.* |
     | vitest | vitest.config.* or package.json "vitest" |
     | pytest | pytest.ini, pyproject.toml [tool.pytest], conftest.py |
     | cargo test | Cargo.toml |
     | go test | *_test.go files |
     | mocha | .mocharc.*, package.json "mocha" |
   - If NO test runner found: HALT
     "No test runner detected. Set up test infrastructure before using /bug."

6. Determine test_type based on bug classification:
   | Classification | Test Type |
   |---------------|-----------|
   | runtime_error, logic_bug | unit |
   | integration_issue | integration |
   | edge_case (user-facing) | e2e |
   | schema/contract violation | contract |

7. Check high-risk patterns in suspected files:
   | Pattern | Risk |
   |---------|------|
   | auth, authentication, login, password, token, jwt, oauth | high |
   | payment, billing, charge, stripe, checkout | high |
   | migration, schema, database, db | high |
   | encrypt, decrypt, secret, credential, key | high |
   | All other files | low/medium |
```

