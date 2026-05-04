// public/js/chat.js — Chat Interface Logic (T2.7)
//
// Manages conversation lifecycle, message rendering, WebSocket streaming,
// and personality theming for the chat page.

;(function () {
  "use strict"

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    tokenId: null,
    collection: null,
    conversations: [],
    currentConvId: null,
    messages: [],
    isStreaming: false,
    streamStartTime: 0,
    jwt: null,
    wsClient: null,
    personality: null,
    /** Degradation state (T3.10): "ok" | "reconnecting" | "unavailable" */
    degradation: "ok",
    /** Count of consecutive HTTP fallback failures (T3.10) */
    httpFailCount: 0,
    /** Auto-retry timer for HTTP fallback (T3.10) */
    retryTimer: null,
  }

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------

  const $ = (sel) => document.querySelector(sel)
  const messagesList = $("#messages-list")
  const messageInput = $("#message-input")
  const btnSend = $("#btn-send")
  const btnAbort = $("#btn-abort")
  const btnNewChat = $("#btn-new-chat")
  const btnMenu = $("#btn-menu")
  const sidebar = $("#sidebar")
  const sidebarToggle = $("#sidebar-toggle")
  const conversationList = $("#conversation-list")
  const typingIndicator = $("#typing-indicator")
  const thinkingIndicator = $("#thinking-indicator")
  const connectionStatus = $("#connection-status")
  const agentName = $("#agent-name")
  const creditDisplay = $("#credit-display")
  const degradationBanner = $("#degradation-banner")
  const degradationMessage = $("#degradation-message")

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async function init() {
    // Parse route: /chat/:collection/:tokenId
    const parts = window.location.pathname.split("/").filter(Boolean)
    if (parts.length >= 3 && parts[0] === "chat") {
      state.collection = parts[1]
      state.tokenId = parts[2]
    }

    // Load JWT from localStorage
    state.jwt = localStorage.getItem("finn_jwt")

    if (!state.jwt) {
      showAuthPrompt()
      return
    }

    // Load personality data
    await loadPersonality()

    // Load conversations
    await loadConversations()

    // Setup WebSocket
    setupWebSocket()

    // Setup event listeners
    setupListeners()
  }

  // ---------------------------------------------------------------------------
  // Personality
  // ---------------------------------------------------------------------------

  async function loadPersonality() {
    if (!state.tokenId) return
    try {
      const res = await fetch(`/api/v1/agent/${state.collection}/${state.tokenId}/public`)
      if (res.ok) {
        state.personality = await res.json()
        applyTheme(state.personality)
        agentName.textContent = state.personality.display_name || "Agent"

        // Update sidebar personality card
        const card = $("#sidebar-personality")
        if (card && state.personality) {
          card.setAttribute("archetype", state.personality.archetype || "")
          card.setAttribute("display-name", state.personality.display_name || "")
        }
      }
    } catch {
      // Best effort
    }
  }

  function applyTheme(personality) {
    if (personality?.archetype) {
      document.documentElement.setAttribute("data-archetype", personality.archetype)
    }
    if (personality?.element) {
      document.documentElement.setAttribute("data-element", personality.element)
    }
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  async function loadConversations() {
    try {
      const nftId = `${state.collection}:${state.tokenId}`
      const res = await apiFetch(`/api/v1/conversations?nft_id=${encodeURIComponent(nftId)}`)
      if (res.ok) {
        const data = await res.json()
        state.conversations = data.items || []
        renderConversationList()

        // Auto-select most recent
        if (state.conversations.length > 0 && !state.currentConvId) {
          selectConversation(state.conversations[0].id)
        }
      }
    } catch {
      // Best effort
    }
  }

  function renderConversationList() {
    conversationList.innerHTML = ""
    const now = Date.now()

    for (const conv of state.conversations) {
      const el = document.createElement("div")
      el.className = "conversation-item" + (conv.id === state.currentConvId ? " active" : "")
      el.dataset.id = conv.id

      const preview = conv.last_message_preview || "No messages yet"
      const timeAgo = formatTimeAgo(now - conv.updated_at)

      el.innerHTML = `
        <div class="conv-preview">${escapeHtml(preview.slice(0, 60))}</div>
        <div class="conv-meta">
          <span class="conv-time">${timeAgo}</span>
          <span class="conv-count">${conv.message_count} msg${conv.message_count !== 1 ? "s" : ""}</span>
        </div>
      `
      el.addEventListener("click", () => selectConversation(conv.id))
      conversationList.appendChild(el)
    }
  }

  async function selectConversation(convId) {
    state.currentConvId = convId
    renderConversationList()
    await loadMessages(convId)
  }

  async function createNewConversation() {
    try {
      const nftId = `${state.collection}:${state.tokenId}`
      const res = await apiFetch("/api/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nft_id: nftId }),
      })
      if (res.ok) {
        const conv = await res.json()
        state.conversations.unshift(conv)
        state.currentConvId = conv.id
        state.messages = []
        renderConversationList()
        renderMessages()
        messageInput.focus()
      }
    } catch {
      showError("Failed to create conversation")
    }
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async function loadMessages(convId) {
    try {
      const res = await apiFetch(`/api/v1/conversations/${convId}/messages?limit=50`)
      if (res.ok) {
        const data = await res.json()
        state.messages = data.items || []
        renderMessages()
        scrollToBottom()
      }
    } catch {
      // Best effort
    }
  }

  function renderMessages() {
    messagesList.innerHTML = ""
    for (const msg of state.messages) {
      appendMessageBubble(msg)
    }
  }

  function appendMessageBubble(msg) {
    const el = document.createElement("div")
    el.className = `message message-${msg.role}`

    const content = document.createElement("div")
    content.className = "message-content"
    content.textContent = msg.content

    const meta = document.createElement("div")
    meta.className = "message-meta"

    const time = document.createElement("span")
    time.className = "message-time"
    time.textContent = formatTime(msg.timestamp)
    time.title = new Date(msg.timestamp).toLocaleString()
    meta.appendChild(time)

    if (msg.cost_cu && msg.role === "assistant") {
      const cost = document.createElement("span")
      cost.className = "message-cost"
      cost.textContent = `${msg.cost_cu} CU`
      cost.title = "Compute Units used"
      meta.appendChild(cost)
    }

    el.appendChild(content)
    el.appendChild(meta)
    messagesList.appendChild(el)
  }

  // ---------------------------------------------------------------------------
  // Send / Stream
  // ---------------------------------------------------------------------------

  async function sendMessage() {
    const text = messageInput.value.trim()
    if (!text || state.isStreaming) return

    if (!state.currentConvId) {
      await createNewConversation()
      if (!state.currentConvId) return
    }

    // Add user message to UI
    const userMsg = { role: "user", content: text, timestamp: Date.now() }
    state.messages.push(userMsg)
    appendMessageBubble(userMsg)
    scrollToBottom()

    messageInput.value = ""
    messageInput.style.height = "auto"
    updateSendButton()

    // Start streaming
    state.isStreaming = true
    state.streamStartTime = Date.now()
    btnSend.classList.add("hidden")
    btnAbort.classList.remove("hidden")
    showTypingIndicator()

    // Check for slow thinking (> 3s)
    const thinkingTimer = setTimeout(() => {
      if (state.isStreaming) {
        typingIndicator.classList.add("hidden")
        thinkingIndicator.classList.remove("hidden")
      }
    }, 3000)

    try {
      // Send via WebSocket if connected, else HTTP fallback
      if (state.wsClient && state.wsClient.readyState === 1) {
        sendViaWebSocket(text)
      } else {
        await sendViaHttp(text)
      }
    } catch {
      // Graceful degradation (T3.10): track failure, show banner, schedule retry
      state.httpFailCount++
      if (state.httpFailCount >= 2) {
        setDegradation("unavailable")
        scheduleAutoRetry(text)
      } else {
        setDegradation("reconnecting")
      }
    } finally {
      clearTimeout(thinkingTimer)
      state.isStreaming = false
      btnAbort.classList.add("hidden")
      btnSend.classList.remove("hidden")
      hideTypingIndicator()
      thinkingIndicator.classList.add("hidden")
    }
  }

  function sendViaWebSocket(text) {
    if (!state.wsClient) return

    // Create streaming agent message element
    const agentEl = createStreamingBubble()

    state.wsClient.send(JSON.stringify({
      type: "prompt",
      text,
      conversation_id: state.currentConvId,
      token_id: `${state.collection}:${state.tokenId}`,
    }))

    // Handle streaming response via existing event listeners
    state._streamEl = agentEl
  }

  async function sendViaHttp(text) {
    const res = await apiFetch("/api/v1/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_id: `${state.collection}:${state.tokenId}`,
        message: text,
        session_id: state.currentConvId,
      }),
    })

    if (res.ok) {
      const data = await res.json()
      const agentMsg = {
        role: "assistant",
        content: data.response,
        timestamp: Date.now(),
        cost_cu: data.billing?.amount_micro ? String(data.billing.amount_micro) : undefined,
      }
      state.messages.push(agentMsg)
      appendMessageBubble(agentMsg)
      scrollToBottom()
      // Success — clear degradation state (T3.10)
      state.httpFailCount = 0
      setDegradation("ok")
    } else {
      // HTTP returned an error status — escalate to degradation (T3.10)
      state.httpFailCount++
      if (state.httpFailCount >= 2) {
        setDegradation("unavailable")
      } else {
        setDegradation("reconnecting")
      }
    }
  }

  function createStreamingBubble() {
    const el = document.createElement("div")
    el.className = "message message-assistant streaming"

    const content = document.createElement("div")
    content.className = "message-content"
    el.appendChild(content)

    messagesList.appendChild(el)
    scrollToBottom()
    return el
  }

  function abortStream() {
    if (state.wsClient) {
      state.wsClient.send(JSON.stringify({ type: "abort" }))
    }
    state.isStreaming = false
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  function setupWebSocket() {
    if (!state.jwt) return

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const wsUrl = `${protocol}//${window.location.host}/ws`

    try {
      const ws = new WebSocket(wsUrl)
      state.wsClient = ws

      ws.addEventListener("open", () => {
        // Auth on first message
        ws.send(JSON.stringify({ type: "auth", token: `Bearer ${state.jwt}` }))
        updateConnectionStatus("connected")
        // Clear degradation on successful WS connect (T3.10)
        state.httpFailCount = 0
        setDegradation("ok")
      })

      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data)
          handleWsMessage(msg)
        } catch { /* ignore malformed */ }
      })

      ws.addEventListener("close", () => {
        updateConnectionStatus("disconnected")
        // Show reconnecting banner instead of error (T3.10)
        setDegradation("reconnecting")
        // Auto-reconnect after 3s
        setTimeout(setupWebSocket, 3000)
      })

      ws.addEventListener("error", () => {
        updateConnectionStatus("disconnected")
        setDegradation("reconnecting")
      })
    } catch {
      // WS not available — show reconnecting, HTTP fallback still works (T3.10)
      setDegradation("reconnecting")
    }
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case "text_delta":
        if (state._streamEl) {
          const content = state._streamEl.querySelector(".message-content")
          content.textContent += msg.delta || ""
          hideTypingIndicator()
          thinkingIndicator.classList.add("hidden")
          scrollToBottom()
        }
        break

      case "turn_end":
        if (state._streamEl) {
          state._streamEl.classList.remove("streaming")
          const fullText = state._streamEl.querySelector(".message-content").textContent
          state.messages.push({
            role: "assistant",
            content: fullText,
            timestamp: Date.now(),
          })
          state._streamEl = null
        }
        state.isStreaming = false
        btnAbort.classList.add("hidden")
        btnSend.classList.remove("hidden")
        hideTypingIndicator()
        break

      case "error":
        showError(msg.message || "Stream error")
        state.isStreaming = false
        break
    }
  }

  function updateConnectionStatus(status) {
    connectionStatus.textContent = status
    connectionStatus.className = `connection-status ${status}`
  }

  // ---------------------------------------------------------------------------
  // Event Listeners
  // ---------------------------------------------------------------------------

  function setupListeners() {
    btnSend.addEventListener("click", sendMessage)
    btnAbort.addEventListener("click", abortStream)
    btnNewChat.addEventListener("click", createNewConversation)

    messageInput.addEventListener("input", () => {
      updateSendButton()
      autoResize(messageInput)
    })

    messageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        sendMessage()
      }
    })

    // Sidebar toggle (mobile)
    btnMenu.addEventListener("click", () => sidebar.classList.toggle("open"))
    sidebarToggle.addEventListener("click", () => sidebar.classList.toggle("open"))

    // Close sidebar on outside click (mobile)
    document.addEventListener("click", (e) => {
      if (window.innerWidth < 768 && sidebar.classList.contains("open")) {
        if (!sidebar.contains(e.target) && e.target !== btnMenu) {
          sidebar.classList.remove("open")
        }
      }
    })
  }

  // ---------------------------------------------------------------------------
  // UI Helpers
  // ---------------------------------------------------------------------------

  function updateSendButton() {
    btnSend.disabled = !messageInput.value.trim()
  }

  function autoResize(el) {
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 150) + "px"
  }

  function showTypingIndicator() {
    typingIndicator.classList.remove("hidden")
  }

  function hideTypingIndicator() {
    typingIndicator.classList.add("hidden")
  }

  function scrollToBottom() {
    const container = $("#messages")
    if (container) container.scrollTop = container.scrollHeight
  }

  function showError(msg) {
    const el = document.createElement("div")
    el.className = "message message-system"
    el.textContent = msg
    messagesList.appendChild(el)
    scrollToBottom()
  }

  // ---------------------------------------------------------------------------
  // Degradation Management (T3.10)
  // ---------------------------------------------------------------------------

  /**
   * Update the degradation banner state.
   * "ok" = hidden, "reconnecting" = yellow warning, "unavailable" = red error.
   * Never shows an error page — always preserves last known state.
   */
  function setDegradation(level) {
    state.degradation = level

    if (level === "ok") {
      degradationBanner.classList.add("hidden")
      degradationBanner.classList.remove("degraded-error")
      if (state.retryTimer) {
        clearTimeout(state.retryTimer)
        state.retryTimer = null
      }
      return
    }

    degradationBanner.classList.remove("hidden")

    if (level === "reconnecting") {
      degradationBanner.classList.remove("degraded-error")
      degradationMessage.textContent = "Reconnecting..."
    } else if (level === "unavailable") {
      degradationBanner.classList.add("degraded-error")
      degradationMessage.textContent = "Service temporarily unavailable. Retrying..."
    }
  }

  /**
   * Schedule an auto-retry for a failed message send.
   * Uses exponential backoff capped at 30s.
   */
  function scheduleAutoRetry(text) {
    if (state.retryTimer) clearTimeout(state.retryTimer)

    // Exponential backoff: 3s, 6s, 12s, 24s, capped at 30s
    const backoffMs = Math.min(3000 * Math.pow(2, state.httpFailCount - 1), 30000)

    state.retryTimer = setTimeout(async function () {
      state.retryTimer = null
      try {
        // Attempt WS reconnection first
        if (!state.wsClient || state.wsClient.readyState !== 1) {
          setupWebSocket()
        }
        // Try sending via HTTP fallback
        await sendViaHttp(text)
      } catch {
        // Still failing — schedule another retry
        state.httpFailCount++
        scheduleAutoRetry(text)
      }
    }, backoffMs)
  }

  function showAuthPrompt() {
    messagesList.innerHTML = `
      <div class="auth-prompt">
        <h2>Connect Your Wallet</h2>
        <p>Sign in with your wallet to start chatting.</p>
        <a href="/onboarding" class="btn btn-primary">Connect Wallet</a>
      </div>
    `
  }

  function apiFetch(url, options = {}) {
    const headers = { ...options.headers }
    if (state.jwt) {
      headers["Authorization"] = `Bearer ${state.jwt}`
    }
    return fetch(url, { ...options, headers })
  }

  // ---------------------------------------------------------------------------
  // Formatters
  // ---------------------------------------------------------------------------

  function formatTime(ts) {
    const d = new Date(ts)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  function formatTimeAgo(ms) {
    const s = Math.floor(ms / 1000)
    if (s < 60) return "just now"
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    const d = Math.floor(h / 24)
    return `${d}d ago`
  }

  function escapeHtml(s) {
    const div = document.createElement("div")
    div.textContent = s
    return div.innerHTML
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init)
  } else {
    init()
  }
})()
