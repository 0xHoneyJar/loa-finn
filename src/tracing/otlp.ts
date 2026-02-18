// src/tracing/otlp.ts — Non-fatal OTLP tracing setup (SDD §7, cycle-024 T4)
// Initializes OpenTelemetry with OTLP gRPC exporter. Never crashes the service.

import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"

export interface TracingConfig {
  /** OTLP gRPC endpoint (e.g., "http://tempo.local:4317"). If unset, tracing disabled. */
  endpoint?: string
  /** Deployment environment label (e.g., "production", "staging") */
  environment?: string
}

/**
 * Initialize OpenTelemetry tracing with OTLP gRPC exporter.
 *
 * Returns the provider on success, null if disabled or on failure.
 * NEVER throws — tracing is optional infrastructure, not a boot dependency.
 */
export async function initTracing(config: TracingConfig): Promise<NodeTracerProvider | null> {
  if (!config.endpoint) {
    console.log("[tracing] OTLP_ENDPOINT not set — tracing disabled")
    return null
  }

  try {
    // Dynamic imports to avoid hard dependency when tracing is disabled
    const { NodeTracerProvider: Provider } = await import("@opentelemetry/sdk-trace-node")
    const { SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-node")
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc")
    const { Resource } = await import("@opentelemetry/resources")
    const { ATTR_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions")
    const { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } = await import("@opentelemetry/semantic-conventions/incubating")

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: "loa-finn",
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment ?? "unknown",
    })

    const exporter = new OTLPTraceExporter({ url: config.endpoint })
    const provider = new Provider({ resource })
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter))
    provider.register()

    console.log(`[tracing] OTLP initialized: endpoint=${config.endpoint}`)
    return provider
  } catch (err) {
    console.warn(`[tracing] OTLP initialization failed (non-fatal): ${(err as Error).message}`)
    return null
  }
}
