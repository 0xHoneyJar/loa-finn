// public/agent/wallet.js — Client-side Wallet Connect + SIWE (Sprint 5 Task 5.5)
// Handles wallet connection, SIWE signing, and session management.
// Reuses existing /api/v1/auth/nonce and /api/v1/auth/verify endpoints.

const config = window.__AGENT_CONFIG__;
const connectBtn = document.getElementById("connect-wallet");
const walletStatus = document.getElementById("wallet-status");

let currentSession = null;

// ---------------------------------------------------------------------------
// API Helpers
// ---------------------------------------------------------------------------

async function fetchNonce() {
  const resp = await fetch("/api/v1/auth/nonce");
  if (!resp.ok) throw new Error("Failed to get nonce");
  const data = await resp.json();
  return data.nonce;
}

async function verifySignature(message, signature) {
  const resp = await fetch("/api/v1/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || "Verification failed");
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// SIWE Message Construction
// ---------------------------------------------------------------------------

function buildSiweMessage(address, nonce) {
  const domain = window.location.host;
  const uri = window.location.origin;
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  // EIP-4361 plaintext format
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    `Sign in to chat with ${config.name}`,
    "",
    `URI: ${uri}`,
    `Version: 1`,
    `Chain ID: 8453`,
    `Nonce: ${nonce}`,
    `Issued At: ${now}`,
    `Expiration Time: ${expiry}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Wallet Connection Flow
// ---------------------------------------------------------------------------

async function connectWallet() {
  // Check for injected provider (MetaMask, etc.)
  if (!window.ethereum) {
    showManualInput();
    return;
  }

  try {
    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting...";

    // Request accounts
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const address = accounts[0];

    // Get nonce from server
    const nonce = await fetchNonce();

    // Build and sign SIWE message
    const message = buildSiweMessage(address, nonce);
    const signature = await window.ethereum.request({
      method: "personal_sign",
      params: [message, address],
    });

    // Verify on server
    const session = await verifySignature(message, signature);
    currentSession = session;

    // Store in cookie for session persistence
    document.cookie = `access_token=${session.access_token}; path=/; secure; samesite=strict; max-age=900`;

    onAuthenticated(session.address, session.access_token, session.session_id);
  } catch (err) {
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect Wallet";
    showError(err.message || "Connection failed");
  }
}

// ---------------------------------------------------------------------------
// Manual Signature Input (graceful degradation)
// ---------------------------------------------------------------------------

function showManualInput() {
  walletStatus.innerHTML = `
    <div class="text-sm text-gray-400">
      <p>No wallet detected.</p>
      <p class="mt-1">Install <a href="https://metamask.io" target="_blank" rel="noopener" class="text-amber-400 underline">MetaMask</a> to connect.</p>
    </div>
  `;
}

function showError(message) {
  const errorEl = document.createElement("p");
  errorEl.className = "text-red-400 text-xs mt-1";
  errorEl.textContent = message;
  walletStatus.appendChild(errorEl);
  setTimeout(() => errorEl.remove(), 5000);
}

// ---------------------------------------------------------------------------
// Post-Authentication
// ---------------------------------------------------------------------------

function onAuthenticated(address, accessToken, sessionId) {
  // Update UI
  const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
  walletStatus.innerHTML = `
    <span class="text-green-400 text-sm">${shortAddr}</span>
    <button id="disconnect-wallet" class="ml-3 text-xs text-gray-500 hover:text-gray-300">Disconnect</button>
  `;

  document.getElementById("disconnect-wallet").addEventListener("click", disconnect);

  // Initialize WebSocket
  const wsClient = new window.WSClient();
  wsClient.connect(sessionId, accessToken);
  window.initChat(wsClient);
  window.setInputEnabled(true);
}

function disconnect() {
  currentSession = null;
  document.cookie = "access_token=; path=/; max-age=0";
  window.location.reload();
}

// ---------------------------------------------------------------------------
// Session Restore
// ---------------------------------------------------------------------------

function tryRestoreSession() {
  const cookies = document.cookie.split(";").reduce((acc, c) => {
    const [k, v] = c.trim().split("=");
    if (k && v) acc[k] = v;
    return acc;
  }, {});

  if (cookies.access_token) {
    // Attempt to restore — verify token is still valid
    fetch("/api/v1/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cookies.access_token}`,
      },
      body: JSON.stringify({
        refresh_token: cookies.refresh_token || "",
        session_id: cookies.session_id || "",
      }),
    }).catch(() => {
      // Token expired or invalid — show connect button
    });
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

connectBtn.addEventListener("click", connectWallet);
tryRestoreSession();
