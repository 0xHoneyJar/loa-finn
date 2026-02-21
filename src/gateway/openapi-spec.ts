// src/gateway/openapi-spec.ts — OpenAPI 3.1 Specification (Sprint 7 T7.1)
//
// Builds the OpenAPI spec programmatically from the actual route definitions.
// Served at GET /openapi.json (free endpoint).

// ---------------------------------------------------------------------------
// OpenAPI 3.1 Specification
// ---------------------------------------------------------------------------

export function buildOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Finn Agent API",
      version: "1.0.0",
      description:
        "API for interacting with personality-conditioned AI agents. Supports x402 on-chain payments and API key authentication.",
      contact: {
        name: "The Honey Jar",
        url: "https://thehoneyjar.xyz",
      },
    },
    servers: [
      {
        url: "https://finn.honeyjar.xyz",
        description: "Production",
      },
      {
        url: "http://localhost:3000",
        description: "Local development",
      },
    ],
    paths: {
      "/api/v1/agent/chat": {
        post: {
          operationId: "agentChat",
          summary: "Chat with an agent",
          description:
            "Send a message to a personality-conditioned agent. Requires payment via x402 receipt or API key.",
          tags: ["Agent"],
          security: [{ bearerApiKey: [] }, { x402Payment: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChatRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ChatResponse" },
                },
              },
            },
            "400": {
              description: "Invalid request body or ambiguous payment",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "401": {
              description: "Invalid or revoked API key",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "402": {
              description: "Payment required — returns x402 challenge",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/X402Challenge" },
                },
              },
            },
            "404": {
              description: "Token ID not found",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "429": {
              description: "Rate limit exceeded",
              headers: {
                "X-RateLimit-Remaining": {
                  schema: { type: "integer" },
                },
                "Retry-After": {
                  schema: { type: "integer" },
                },
              },
            },
          },
        },
      },
      "/api/v1/keys": {
        post: {
          operationId: "createApiKey",
          summary: "Create an API key",
          description:
            "Create a new API key. Requires SIWE session. Returns the plaintext key once — store securely.",
          tags: ["Keys"],
          security: [{ siweSession: [] }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      maxLength: 128,
                      description: "Optional human-readable label",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Key created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateKeyResponse" },
                },
              },
            },
            "401": {
              description: "Missing or invalid SIWE session",
            },
          },
        },
      },
      "/api/v1/keys/{key_id}": {
        delete: {
          operationId: "revokeApiKey",
          summary: "Revoke an API key",
          description: "Revoke an API key. Must own the key (verified via SIWE session).",
          tags: ["Keys"],
          security: [{ siweSession: [] }],
          parameters: [
            {
              name: "key_id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Key revoked",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      key_id: { type: "string" },
                      revoked: { type: "boolean", const: true },
                    },
                  },
                },
              },
            },
            "401": { description: "Missing or invalid SIWE session" },
            "404": { description: "Key not found or not owned by this wallet" },
          },
        },
      },
      "/api/v1/keys/{key_id}/balance": {
        get: {
          operationId: "getKeyBalance",
          summary: "Get API key credit balance",
          tags: ["Keys"],
          security: [{ siweSession: [] }],
          parameters: [
            {
              name: "key_id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Balance in micro-USDC",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      key_id: { type: "string" },
                      balance_micro: { type: "integer" },
                    },
                    required: ["key_id", "balance_micro"],
                  },
                },
              },
            },
            "404": { description: "Key not found" },
          },
        },
      },
      "/api/v1/auth/nonce": {
        get: {
          operationId: "getNonce",
          summary: "Get a SIWE nonce",
          description: "Returns a single-use nonce for SIWE authentication (5-minute TTL).",
          tags: ["Auth"],
          responses: {
            "200": {
              description: "Nonce for SIWE message",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      nonce: { type: "string" },
                    },
                    required: ["nonce"],
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/auth/verify": {
        post: {
          operationId: "verifySiwe",
          summary: "Verify SIWE signature",
          description:
            "Validates a signed SIWE message and returns a JWT session token (15-minute expiry).",
          tags: ["Auth"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: {
                      type: "string",
                      description: "EIP-4361 SIWE message",
                    },
                    signature: {
                      type: "string",
                      description: "Ethereum signature",
                    },
                  },
                  required: ["message", "signature"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Session token issued",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      token: { type: "string" },
                      expires_in: { type: "integer" },
                      wallet_address: { type: "string" },
                    },
                    required: ["token", "expires_in", "wallet_address"],
                  },
                },
              },
            },
            "400": { description: "Invalid request body or SIWE message" },
            "401": { description: "Invalid credentials, expired nonce, or bad signature" },
          },
        },
      },
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Health check",
          description: "Returns service health status. No authentication required.",
          tags: ["System"],
          responses: {
            "200": {
              description: "Service is healthy",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthResponse" },
                },
              },
            },
          },
        },
      },
      "/metrics": {
        get: {
          operationId: "getMetrics",
          summary: "Prometheus metrics",
          description:
            "Returns metrics in Prometheus exposition format. Requires Bearer token in production.",
          tags: ["System"],
          security: [{ metricsBearer: [] }],
          responses: {
            "200": {
              description: "Prometheus text format",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
            "401": { description: "Missing authorization" },
            "403": { description: "Invalid token" },
          },
        },
      },
      "/llms.txt": {
        get: {
          operationId: "getLlmsTxt",
          summary: "Agent capability manifest",
          description: "Returns agent capabilities in llms.txt format. No authentication required.",
          tags: ["Discovery"],
          responses: {
            "200": {
              description: "llms.txt format",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      "/agents.md": {
        get: {
          operationId: "getAgentsMd",
          summary: "Agent directory",
          description:
            "Returns human-readable agent directory in Markdown. No authentication required.",
          tags: ["Discovery"],
          responses: {
            "200": {
              description: "Markdown agent directory",
              content: {
                "text/markdown": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      "/agent/{tokenId}": {
        get: {
          operationId: "getAgentHomepage",
          summary: "Agent homepage",
          description:
            "Returns HTML page for a specific agent with personality summary and capabilities.",
          tags: ["Discovery"],
          parameters: [
            {
              name: "tokenId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Agent homepage HTML",
              content: {
                "text/html": {
                  schema: { type: "string" },
                },
              },
            },
            "404": { description: "Token ID not found" },
          },
        },
      },
    },
    components: {
      schemas: {
        ChatRequest: {
          type: "object",
          properties: {
            token_id: {
              type: "string",
              description: "NFT token ID identifying the agent personality",
            },
            message: {
              type: "string",
              description: "User message",
            },
            session_id: {
              type: "string",
              description: "Optional session ID for conversation continuity",
            },
          },
          required: ["token_id", "message"],
        },
        ChatResponse: {
          type: "object",
          properties: {
            response: {
              type: "string",
              description: "Agent response text",
            },
            personality: {
              type: "object",
              properties: {
                archetype: {
                  type: "string",
                  enum: ["freetekno", "milady", "chicago_detroit", "acidhouse"],
                },
                display_name: { type: "string" },
              },
              required: ["archetype", "display_name"],
            },
            billing: {
              type: "object",
              properties: {
                method: {
                  type: "string",
                  enum: ["free", "x402", "api_key"],
                },
                amount_micro: {
                  type: "string",
                  description: "Amount charged in micro-USDC",
                },
                request_id: { type: "string" },
              },
            },
          },
          required: ["response", "personality"],
        },
        X402Challenge: {
          type: "object",
          properties: {
            error: { type: "string", const: "Payment required" },
            code: { type: "string", const: "PAYMENT_REQUIRED" },
            challenge: {
              type: "object",
              description: "HMAC-signed challenge for x402 on-chain payment",
              properties: {
                nonce: { type: "string" },
                amount: { type: "string", description: "Amount in micro-USDC" },
                recipient: { type: "string", description: "USDC recipient address" },
                chain_id: { type: "integer" },
                expires_at: { type: "string", format: "date-time" },
                hmac: { type: "string", description: "Challenge HMAC signature" },
              },
              required: ["nonce", "amount", "recipient", "chain_id", "expires_at", "hmac"],
            },
          },
          required: ["error", "code", "challenge"],
        },
        CreateKeyResponse: {
          type: "object",
          properties: {
            key_id: { type: "string" },
            plaintext_key: {
              type: "string",
              description: "The API key (shown once, store securely)",
            },
            message: { type: "string" },
          },
          required: ["key_id", "plaintext_key", "message"],
        },
        HealthResponse: {
          type: "object",
          properties: {
            status: { type: "string" },
            uptime: { type: "number" },
            checks: { type: "object" },
            billing: { type: "object" },
            protocol: { type: "object" },
          },
        },
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            code: { type: "string" },
          },
          required: ["error"],
        },
      },
      securitySchemes: {
        bearerApiKey: {
          type: "http",
          scheme: "bearer",
          description: "API key (dk_ prefix). Obtain via POST /api/v1/keys with SIWE session.",
        },
        x402Payment: {
          type: "apiKey",
          in: "header",
          name: "X-Payment-Receipt",
          description:
            "x402 on-chain payment receipt (tx hash). Also requires X-Payment-Nonce header.",
        },
        siweSession: {
          type: "http",
          scheme: "bearer",
          description: "SIWE session JWT. Obtain via GET /api/v1/auth/nonce + POST /api/v1/auth/verify.",
        },
        metricsBearer: {
          type: "http",
          scheme: "bearer",
          description: "Metrics endpoint bearer token (METRICS_BEARER_TOKEN).",
        },
      },
    },
    tags: [
      { name: "Agent", description: "Personality-conditioned AI agent interactions" },
      { name: "Keys", description: "API key lifecycle management" },
      { name: "Auth", description: "SIWE (Sign-In With Ethereum) authentication" },
      { name: "Discovery", description: "Agent discovery and documentation" },
      { name: "System", description: "Health, metrics, and operational endpoints" },
    ],
  }
}
