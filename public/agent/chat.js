// public/agent/chat.js — Chat Message Rendering + Streaming (Sprint 5 Task 5.4)
// Vanilla JS chat widget. Uses textContent for user messages (XSS safe).
// Assistant messages rendered as sanitized markdown (allowlist: bold, italic, code, links).

const chatMessages = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendButton = document.getElementById("send-button");
const costDisplay = document.getElementById("cost-display");
const lastCostEl = document.getElementById("last-cost");
const balanceDisplay = document.getElementById("balance-display");
const sidebarBalance = document.getElementById("sidebar-balance");
const sidebarMessages = document.getElementById("sidebar-messages");

let messageCount = 0;
let currentStreamEl = null;
let currentStreamText = "";
let wsClient = null;

// ---------------------------------------------------------------------------
// Sanitized Markdown (allowlist: bold, italic, code, links with rel=noopener)
// ---------------------------------------------------------------------------

function sanitizeMarkdown(text) {
  // HTML-escape first
  let safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Allowlisted markdown transformations
  safe = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/\*(.+?)\*/g, "<em>$1</em>");
  safe = safe.replace(/`([^`]+)`/g, '<code class="bg-gray-800 px-1 rounded text-amber-300">$1</code>');
  safe = safe.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-amber-400 underline">$1</a>'
  );
  safe = safe.replace(/\n/g, "<br>");

  return safe;
}

// ---------------------------------------------------------------------------
// Message Rendering
// ---------------------------------------------------------------------------

function addUserMessage(text) {
  const div = document.createElement("div");
  div.className = "flex justify-end";

  const bubble = document.createElement("div");
  bubble.className = "max-w-[70%] bg-amber-600/20 border border-amber-600/30 rounded-lg px-4 py-3 text-sm";
  bubble.textContent = text; // textContent: XSS-safe for user messages
  div.appendChild(bubble);

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  messageCount++;
  updateMessageCount();
}

function startAssistantMessage() {
  const div = document.createElement("div");
  div.className = "flex justify-start";

  const bubble = document.createElement("div");
  bubble.className = "max-w-[70%] bg-gray-800/50 border border-gray-700 rounded-lg px-4 py-3 text-sm assistant-message";

  const typing = document.createElement("span");
  typing.className = "typing-indicator text-gray-400";
  typing.textContent = "...";
  bubble.appendChild(typing);

  div.appendChild(bubble);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  currentStreamEl = bubble;
  currentStreamText = "";
}

function appendStreamDelta(delta) {
  if (!currentStreamEl) return;
  currentStreamText += delta;
  // Render sanitized markdown for assistant messages
  currentStreamEl.innerHTML = sanitizeMarkdown(currentStreamText);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function endAssistantMessage(costCu, balanceCu) {
  currentStreamEl = null;
  currentStreamText = "";
  messageCount++;
  updateMessageCount();

  if (costCu || balanceCu) {
    updateCostDisplay(costCu, balanceCu);
  }
}

function updateCostDisplay(costCu, balanceCu) {
  if (costCu) {
    lastCostEl.textContent = `Cost: ${costCu} CU`;
  }
  if (balanceCu) {
    balanceDisplay.textContent = balanceCu;
    sidebarBalance.textContent = balanceCu;
  }
  costDisplay.classList.remove("hidden");
}

function updateMessageCount() {
  sidebarMessages.textContent = String(messageCount);
}

function showWarning(message) {
  const div = document.createElement("div");
  div.className = "flex justify-center";
  const badge = document.createElement("div");
  badge.className = "bg-yellow-900/30 border border-yellow-700/50 text-yellow-400 text-xs rounded-full px-4 py-1";
  badge.textContent = message;
  div.appendChild(badge);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showError(message) {
  const div = document.createElement("div");
  div.className = "flex justify-center";
  const badge = document.createElement("div");
  badge.className = "bg-red-900/30 border border-red-700/50 text-red-400 text-xs rounded-full px-4 py-1";
  badge.textContent = message;
  div.appendChild(badge);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ---------------------------------------------------------------------------
// WebSocket Message Handler
// ---------------------------------------------------------------------------

function handleWsMessage(msg) {
  switch (msg.type) {
    case "authenticated":
      break;
    case "text_delta":
      if (!currentStreamEl) startAssistantMessage();
      appendStreamDelta(msg.data?.delta || "");
      break;
    case "turn_end":
      endAssistantMessage(msg.data?.cost_cu, msg.data?.balance_cu);
      setInputEnabled(true);
      break;
    case "credit_warning":
      showWarning(`Low balance: ${msg.data?.balance_cu || "?"} CU remaining`);
      break;
    case "billing_blocked":
      showError(msg.data?.reason || "Account blocked");
      setInputEnabled(false);
      break;
    case "tool_start":
      break;
    case "tool_end":
      break;
    case "agent_end":
      break;
    case "error":
      showError(msg.data?.message || "Unknown error");
      if (msg.data?.recoverable) setInputEnabled(true);
      break;
    case "pong":
      break;
  }
}

// ---------------------------------------------------------------------------
// Input Control
// ---------------------------------------------------------------------------

function setInputEnabled(enabled) {
  chatInput.disabled = !enabled;
  sendButton.disabled = !enabled;
  if (enabled) chatInput.focus();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initChat(client) {
  wsClient = client;
  wsClient.on("message", handleWsMessage);

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !wsClient.isConnected) return;

    addUserMessage(text);
    wsClient.sendPrompt(text);
    chatInput.value = "";
    setInputEnabled(false);
    startAssistantMessage();
  });
}

// Export for use by wallet.js
window.initChat = initChat;
window.setInputEnabled = setInputEnabled;
