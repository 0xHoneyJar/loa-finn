// src/bridgebuilder/ports/http-client.ts

export interface HttpRequest {
  url: string
  method: "GET" | "POST" | "PUT" | "DELETE"
  headers?: Record<string, string>
  body?: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
  rateLimitRemaining?: number
}

export interface IHttpClient {
  /** Execute an HTTP request with built-in retry + rate-limit policy. */
  request(req: HttpRequest): Promise<HttpResponse>

  /** Check remaining rate limit budget. Returns undefined if not tracked. */
  getRateLimitRemaining(): number | undefined
}
