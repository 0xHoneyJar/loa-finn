// tests/gateway/public-url.test.ts — Trusted public URL construction (#198, #213, #224, #230, #236)

import { describe, it, expect } from "vitest"
import {
  buildSessionWsUrl,
  sanitizeHostHeader,
  validatePublicBaseUrl,
} from "../../src/gateway/public-url.js"

const SESSION_ID = "sess-abc-123"

describe("validatePublicBaseUrl", () => {
  it("accepts https URLs and normalizes to origin", () => {
    expect(validatePublicBaseUrl("https://finn.honeyjar.xyz")).toBe("https://finn.honeyjar.xyz")
    expect(validatePublicBaseUrl("https://finn.honeyjar.xyz/")).toBe("https://finn.honeyjar.xyz")
  })

  it("accepts http URLs with ports", () => {
    expect(validatePublicBaseUrl("http://localhost:3000")).toBe("http://localhost:3000")
  })

  it("rejects non-http(s) schemes", () => {
    expect(() => validatePublicBaseUrl("ftp://example.com")).toThrow(/http/)
    expect(() => validatePublicBaseUrl("javascript:alert(1)")).toThrow()
    expect(() => validatePublicBaseUrl("ws://example.com")).toThrow(/http/)
  })

  it("rejects relative or malformed values", () => {
    expect(() => validatePublicBaseUrl("finn.honeyjar.xyz")).toThrow(/absolute/)
    expect(() => validatePublicBaseUrl("")).toThrow(/absolute/)
    expect(() => validatePublicBaseUrl("https://")).toThrow()
  })

  it("rejects URLs with a path, query, or fragment", () => {
    expect(() => validatePublicBaseUrl("https://example.com/api")).toThrow(/path/)
    expect(() => validatePublicBaseUrl("https://example.com/?x=1")).toThrow(/path/)
    expect(() => validatePublicBaseUrl("https://example.com/#frag")).toThrow(/path/)
  })
})

describe("sanitizeHostHeader", () => {
  it("accepts loopback/local hosts and host:port", () => {
    expect(sanitizeHostHeader("localhost:3000")).toBe("localhost:3000")
    expect(sanitizeHostHeader("localhost")).toBe("localhost")
    expect(sanitizeHostHeader("app.localhost:8080")).toBe("app.localhost:8080")
    expect(sanitizeHostHeader("127.0.0.1:8080")).toBe("127.0.0.1:8080")
    expect(sanitizeHostHeader("0.0.0.0:3000")).toBe("0.0.0.0:3000")
  })

  it("rejects syntactically valid but NON-local hosts — the Host-forgery class", () => {
    // A well-formed public hostname must never become the advertised WS
    // origin: without PUBLIC_BASE_URL a forged Host header would otherwise
    // redirect WS clients to an attacker host in a misconfigured deployment.
    expect(sanitizeHostHeader("finn.honeyjar.xyz")).toBeNull()
    expect(sanitizeHostHeader("evil.example.com:443")).toBeNull()
    expect(sanitizeHostHeader("10.0.0.5:8080")).toBeNull()
    expect(sanitizeHostHeader("128.0.0.1")).toBeNull() // not 127.0.0.0/8
  })

  it("rejects missing/empty values", () => {
    expect(sanitizeHostHeader(undefined)).toBeNull()
    expect(sanitizeHostHeader("")).toBeNull()
  })

  it("rejects malicious Host header values", () => {
    // Header/response splitting
    expect(sanitizeHostHeader("evil.com\r\nX-Injected: 1")).toBeNull()
    // Embedded path — would smuggle a different WS endpoint
    expect(sanitizeHostHeader("evil.com/ws/hijack?x=")).toBeNull()
    // Scheme smuggling
    expect(sanitizeHostHeader("https://evil.com")).toBeNull()
    // Markup injection (wsUrl is echoed in JSON consumed by web clients)
    expect(sanitizeHostHeader('evil.com"><script>')).toBeNull()
    // Whitespace
    expect(sanitizeHostHeader("evil .com")).toBeNull()
    // Userinfo trick
    expect(sanitizeHostHeader("good.com@evil.com")).toBeNull()
    // Leading/trailing dots or dashes
    expect(sanitizeHostHeader("-evil.com")).toBeNull()
    // Oversized
    expect(sanitizeHostHeader("a".repeat(300))).toBeNull()
  })
})

describe("buildSessionWsUrl", () => {
  it("uses configured public base URL — https maps to wss", () => {
    const url = buildSessionWsUrl({
      publicBaseUrl: "https://finn.honeyjar.xyz",
      hostHeader: "evil.com", // must be ignored when config is present
      port: 3000,
      sessionId: SESSION_ID,
    })
    expect(url).toBe(`wss://finn.honeyjar.xyz/ws/${SESSION_ID}`)
  })

  it("uses configured public base URL — http maps to ws", () => {
    const url = buildSessionWsUrl({
      publicBaseUrl: "http://localhost:3000",
      hostHeader: undefined,
      port: 3000,
      sessionId: SESSION_ID,
    })
    expect(url).toBe(`ws://localhost:3000/ws/${SESSION_ID}`)
  })

  it("ignores the Host header entirely when public base URL is configured", () => {
    const url = buildSessionWsUrl({
      publicBaseUrl: "https://finn.honeyjar.xyz",
      hostHeader: "attacker.example\r\nX: y",
      port: 3000,
      sessionId: SESSION_ID,
    })
    expect(url).toBe(`wss://finn.honeyjar.xyz/ws/${SESSION_ID}`)
  })

  it("falls back to a validated Host header when config is absent (dev)", () => {
    const url = buildSessionWsUrl({
      publicBaseUrl: "",
      hostHeader: "localhost:4000",
      port: 3000,
      sessionId: SESSION_ID,
    })
    expect(url).toBe(`ws://localhost:4000/ws/${SESSION_ID}`)
  })

  it("falls back to localhost:<port> for malicious Host headers", () => {
    for (const hostHeader of [
      "evil.com/ws/hijack",
      "evil.com\r\nX-Injected: 1",
      'evil.com"><script>',
      "https://evil.com",
      "good.com@evil.com",
    ]) {
      const url = buildSessionWsUrl({ publicBaseUrl: "", hostHeader, port: 3000, sessionId: SESSION_ID })
      expect(url).toBe(`ws://localhost:3000/ws/${SESSION_ID}`)
    }
  })

  it("falls back to localhost:<port> for well-formed but non-local Host headers", () => {
    const url = buildSessionWsUrl({
      publicBaseUrl: "",
      hostHeader: "evil.example.com",
      port: 3000,
      sessionId: SESSION_ID,
    })
    expect(url).toBe(`ws://localhost:3000/ws/${SESSION_ID}`)
  })

  it("falls back to localhost:<port> when Host header is missing", () => {
    const url = buildSessionWsUrl({ publicBaseUrl: "", hostHeader: undefined, port: 8080, sessionId: SESSION_ID })
    expect(url).toBe(`ws://localhost:8080/ws/${SESSION_ID}`)
  })
})
