# TASK-1.0: MCP SDK Interception Spike Result

## Verdict: GO

The Pi SDK tool interception pattern works cleanly. Tools are plain objects with an `execute()` method. Wrapping them before passing to `createAgentSession()` leaves no bypass path.

## What was proven

### 1. Tool enumeration

Tools passed to `createAgentSession()` arrive as two plain arrays:

- `tools: Tool[]` (built-in tools like read, bash, edit, write)
- `customTools: ToolDefinition[]` (custom tools like beads_status, grimoire_read)

Both are iterable arrays of objects with inspectable properties (`name`, `label`, `description`, `parameters`, `execute`). The `enumerateTools()` helper proves full enumeration works.

### 2. Execute interception

Each tool's `execute()` method can be replaced with a wrapper that:

```typescript
const wrappedExecute = async (toolCallId, params, signal, onUpdate, ctx) => {
  // pre-hook: inspect/block
  const preResult = await preHook({ toolName, toolCallId, params, timestamp })
  if (preResult.action === "deny") {
    return { content: [{ type: "text", text: `blocked: ${preResult.reason}` }], details: {} }
  }

  // original execution
  const result = await originalExecute.call(tool, toolCallId, params, signal, onUpdate, ctx)

  // post-hook: audit/inspect
  await postHook({ toolName, toolCallId, params, result, durationMs })

  return result
}
```

The original `execute()` reference is captured in a closure and never exposed. The wrapper preserves the full `ToolDefinition` interface including `renderCall` and `renderResult`.

### 3. Re-registration (array replacement)

The wrapped tools are returned as a new array. The caller passes this array to `createAgentSession()` instead of the originals:

```typescript
const firewalled = wrapToolsWithFirewall(tools, { preHook, postHook })
const { session } = await createAgentSession({ tools: firewalled, customTools: firewalledCustom })
```

### 4. No bypass path

The agent session receives only the wrapped array. The original `ToolDefinition` objects are never registered with the session. The LLM can only invoke tools through the wrapped `execute()` because that is the only reference the session holds.

## Limitations found

| Limitation | Severity | Mitigation |
|---|---|---|
| `tools` uses `Tool` (AgentTool) type, `customTools` uses `ToolDefinition` type. Both need wrapping but have slightly different execute signatures (AgentTool has 4 params, ToolDefinition has 5 with ExtensionContext). | Low | Provide separate wrappers or a union wrapper. In practice, Finn already creates ToolDefinition-shaped objects for both via `createBashTool()` etc. |
| Extension-registered tools (`pi.registerTool()`) are added after `createAgentSession()` and bypass this interception. | Medium | Use the SDK's `tool_call` event hook (`pi.on("tool_call", ...)`) for extension tools, or wrap them at extension load time. |
| Post-hook cannot currently mutate/redact the result. | Low | Add a `redact` action to PostHookResult if output filtering is needed. |
| Object spread (`{ ...tool }`) creates a shallow copy. If the SDK ever adds non-enumerable or prototype methods to ToolDefinition, they would be lost. | Very Low | ToolDefinition is a plain interface (no class, no prototype chain). The SDK documents it as a plain object pattern. |
| The `Tool` type (AgentTool) wrapping requires a slightly different adapter because its execute() takes 4 params (no ExtensionContext). | Low | Write a parallel `wrapAgentTools()` for built-in tools, or normalize at the call site. |

## Architecture recommendation

### Recommended: Firewall-as-wrapper (this spike's approach)

```
Session bootstrap:
  tools[] ──> wrapToolsWithFirewall() ──> firewalled[] ──> createAgentSession()
  customTools[] ──> wrapToolsWithFirewall() ──> firewalledCustom[] ──> createAgentSession()

Runtime:
  LLM calls tool ──> wrapped.execute() ──> preHook (allow/deny) ──> original.execute() ──> postHook (audit)
```

**Why this approach:**

1. **Single chokepoint**: All tool calls flow through the wrapper. No SDK internals to monkey-patch.
2. **SDK-stable**: Uses only the public `ToolDefinition` interface. No dependency on SDK internals.
3. **Composable**: Multiple layers can be stacked (sandbox wrapper -> firewall wrapper -> audit wrapper).
4. **Testable**: Each wrapper is a pure function that takes tools in and returns tools out.

### File placement for production

```
src/safety/
  firewall.ts          -- wrapToolsWithFirewall(), hook types
  tool-registry.ts     -- existing MCP tool registry (capability gating)
  audit-trail.ts       -- structured audit log for firewall events
```

### Integration point

In `src/agent/session.ts`, wrap tools immediately before the `createAgentSession()` call. This is the last point where tool arrays are mutable and the only place registration happens.

## Files

- Spike implementation: `src/safety/__spike__/mcp-interception-spike.ts`
- This report: `src/safety/__spike__/SPIKE-RESULT.md`
