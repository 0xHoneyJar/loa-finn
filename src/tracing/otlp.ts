// src/tracing/otlp.ts — OpenTelemetry Tracing Setup (Sprint 12 Task 12.1)
//
// Feature-flagged: OTEL_ENABLED=true to activate (default off).
// Console exporter by default, OTLP when OTEL_EXPORTER_OTLP_ENDPOINT env var set.
// getTracer(name) helper for creating spans in business logic.
// correlation_id from billing entries attached as span attribute.

import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TracingConfig {
  /** OTLP endpoint (e.g., "http://tempo.local:4317"). If unset, uses console exporter. */
  endpoint?: string
  /** Deployment environment label (e.g., "production", "staging") */
  environment?: string
  /** Service version (e.g., "1.0.0") */
  version?: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _provider: NodeTracerProvider | null = null
let _enabled = false

/** Check if tracing is currently active. */
export function isTracingEnabled(): boolean {
  return _enabled
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize OpenTelemetry tracing with NodeTracerProvider.
 *
 * Feature-flagged: only activates when OTEL_ENABLED=true.
 * Console exporter when no OTLP endpoint configured; OTLP gRPC when
 * OTEL_EXPORTER_OTLP_ENDPOINT env var is set.
 *
 * Resource attributes: service.name = "loa-finn", service.version,
 * deployment.environment.
 *
 * Returns the provider on success, null if disabled or on failure.
 * NEVER throws — tracing is optional infrastructure, not a boot dependency.
 */
export async function initTracing(config?: TracingConfig): Promise<NodeTracerProvider | null> {
  if (process.env.OTEL_ENABLED !== "true") {
    console.log("[tracing] OTEL_ENABLED not set — tracing disabled")
    return null
  }

  const endpoint = config?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT

  try {
    // Dynamic imports to avoid hard dependency when tracing is disabled
    const { NodeTracerProvider: Provider, SimpleSpanProcessor, BatchSpanProcessor, ConsoleSpanExporter } =
      await import("@opentelemetry/sdk-trace-node")
    const { Resource } = await import("@opentelemetry/resources")
    const { ATTR_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions")

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: "loa-finn",
      "service.version": config?.version ?? process.env.npm_package_version ?? "unknown",
      "deployment.environment": config?.environment ?? process.env.NODE_ENV ?? "unknown",
    })

    const provider = new Provider({ resource })

    if (endpoint) {
      // BatchSpanProcessor for remote OTLP: buffers spans and flushes in batches
      // to avoid synchronous blocking on every span completion.
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc")
      provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint })))
      console.log(`[tracing] OTLP initialized: endpoint=${endpoint} (batch processor)`)
    } else {
      // SimpleSpanProcessor for console: acceptable for local dev (no network I/O)
      provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()))
      console.log("[tracing] Console exporter initialized (no OTEL_EXPORTER_OTLP_ENDPOINT)")
    }

    provider.register()
    _provider = provider
    _enabled = true
    return provider
  } catch (err) {
    console.warn(`[tracing] Initialization failed (non-fatal): ${(err as Error).message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Tracer Helper
// ---------------------------------------------------------------------------

/**
 * Get a named tracer for creating spans in business logic.
 * Returns null if tracing is disabled or @opentelemetry/api is not installed.
 *
 * Usage:
 *   const tracer = getTracer("x402")
 *   const span = tracer?.startSpan("x402.quote", { attributes: { quote_id } })
 *   try { ... } finally { span?.end() }
 */
/** Minimal tracer interface for span creation (subset of @opentelemetry/api Tracer) */
export interface MinimalTracer {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): {
    setAttribute(key: string, value: string | number | boolean): void
    end(): void
  }
}

export function getTracer(name: string): MinimalTracer | null {
  if (!_enabled) return null
  return _getTracerInternal(name)
}

function _getTracerInternal(name: string): MinimalTracer | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trace } = require("@opentelemetry/api")
    return trace.getTracer(name) as MinimalTracer
  } catch {
    return null
  }
}

/**
 * Set correlation_id on the currently active span (if any).
 * Links billing correlation_id to trace context for cross-referencing.
 */
export function setCorrelationId(correlationId: string): void {
  if (!_enabled) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trace } = require("@opentelemetry/api")
    const span = trace.getActiveSpan()
    if (span) {
      span.setAttribute("correlation_id", correlationId)
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Shutdown the trace provider (graceful teardown).
 */
export async function shutdownTracing(): Promise<void> {
  if (_provider) {
    await _provider.shutdown()
    _provider = null
    _enabled = false
  }
}
