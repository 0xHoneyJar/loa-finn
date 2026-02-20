// public/agent/ws-client.js — WebSocket Chat Client (Sprint 5 Task 5.4)
// Vanilla JS WebSocket connection with auto-reconnect and exponential backoff.

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_FACTOR = 2;

class WSClient {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.reconnectTimer = null;
    this.listeners = { message: [], open: [], close: [], error: [] };
    this.authenticated = false;
  }

  connect(sessionId, token) {
    this.sessionId = sessionId;
    this.token = token;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/${sessionId}`;

    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
      // Authenticate if token provided
      if (this.token) {
        this.ws.send(JSON.stringify({ type: "auth", token: this.token }));
      }
      this._emit("open");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._emit("message", msg);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = (event) => {
      this.authenticated = false;
      this._emit("close", { code: event.code, reason: event.reason });
      // Auto-reconnect unless intentionally closed
      if (event.code !== 1000) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this._emit("error");
    };
  }

  send(type, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...data }));
    }
  }

  sendPrompt(text) {
    this.send("prompt", { text });
  }

  abort() {
    this.send("abort", {});
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "User disconnected");
      this.ws = null;
    }
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
    return () => {
      this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
    };
  }

  _emit(event, data) {
    for (const cb of this.listeners[event] || []) {
      try { cb(data); } catch { /* listener error */ }
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.sessionId, this.token);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * RECONNECT_FACTOR, RECONNECT_MAX_MS);
  }

  get isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

// Export as global for vanilla JS usage
window.WSClient = WSClient;
