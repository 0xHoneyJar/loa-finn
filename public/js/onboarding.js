// public/js/onboarding.js — Onboarding Flow Logic (T2.11)
//
// 5-step wizard consuming existing backend API at /api/v1/onboarding/*.

;(function () {
  "use strict"

  const state = {
    step: 1,
    sessionId: null,
    walletAddress: null,
    jwt: null,
    selectedNft: null,
    personality: null,
  }

  const $ = (sel) => document.querySelector(sel)

  // -------------------------------------------------------------------------
  // Step Navigation
  // -------------------------------------------------------------------------

  function goToStep(n) {
    state.step = n
    document.querySelectorAll(".step").forEach((el) => el.classList.add("hidden"))
    const target = $(`#step-${n}`)
    if (target) target.classList.remove("hidden")

    document.querySelectorAll(".progress-step").forEach((el) => {
      const s = parseInt(el.dataset.step, 10)
      el.classList.toggle("active", s <= n)
      el.classList.toggle("current", s === n)
    })
  }

  // -------------------------------------------------------------------------
  // Step 1: Wallet Connect
  // -------------------------------------------------------------------------

  async function connectWallet(type) {
    const errorEl = $("#wallet-error")
    errorEl.classList.add("hidden")

    try {
      if (!window.ethereum) {
        errorEl.textContent = "No wallet detected. Please install MetaMask or another Web3 wallet."
        errorEl.classList.remove("hidden")
        return
      }

      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" })
      if (!accounts || accounts.length === 0) {
        errorEl.textContent = "Wallet connection was rejected."
        errorEl.classList.remove("hidden")
        return
      }

      state.walletAddress = accounts[0]

      // SIWE auth flow
      const nonceRes = await fetch(`/api/v1/auth/nonce?address=${state.walletAddress}`)
      if (!nonceRes.ok) throw new Error("Failed to get nonce")
      const { nonce } = await nonceRes.json()

      // Build SIWE message
      const domain = window.location.host
      const uri = window.location.origin
      const issuedAt = new Date().toISOString()
      const message = [
        `${domain} wants you to sign in with your Ethereum account:`,
        state.walletAddress,
        "",
        "Sign in to Finn",
        "",
        `URI: ${uri}`,
        "Version: 1",
        "Chain ID: 8453",
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
      ].join("\n")

      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [message, state.walletAddress],
      })

      const verifyRes = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      })

      if (!verifyRes.ok) throw new Error("Verification failed")
      const { token } = await verifyRes.json()
      state.jwt = token
      localStorage.setItem("finn_jwt", token)

      // Start onboarding session
      const startRes = await apiFetch("/api/v1/onboarding/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet_address: state.walletAddress }),
      })

      if (startRes.ok) {
        const data = await startRes.json()
        state.sessionId = data.session_id
      }

      goToStep(2)
      loadNFTs()
    } catch (err) {
      errorEl.textContent = err.message || "Connection failed. Please try again."
      errorEl.classList.remove("hidden")
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: NFT Gallery
  // -------------------------------------------------------------------------

  async function loadNFTs() {
    const gallery = $("#nft-gallery")
    const noNfts = $("#no-nfts")
    gallery.innerHTML = '<div class="loading-spinner">Scanning your wallet...</div>'

    try {
      const res = await apiFetch(
        `/api/v1/onboarding/${state.sessionId}/detect-nfts`,
        { method: "POST" },
      )

      if (!res.ok) throw new Error("Failed to detect NFTs")
      const data = await res.json()
      const nfts = data.nfts || []

      if (nfts.length === 0) {
        gallery.innerHTML = ""
        noNfts.classList.remove("hidden")
        return
      }

      gallery.innerHTML = ""
      for (const nft of nfts) {
        const card = document.createElement("div")
        card.className = "nft-card"
        card.dataset.collection = nft.collection
        card.dataset.tokenId = nft.token_id

        card.innerHTML = `
          <div class="nft-image">${nft.image ? `<img src="${escapeAttr(nft.image)}" alt="${escapeHtml(nft.name || "NFT")}" loading="lazy">` : '<div class="nft-placeholder">NFT</div>'}</div>
          <div class="nft-info">
            <div class="nft-name">${escapeHtml(nft.name || `#${nft.token_id}`)}</div>
            <div class="nft-collection">${escapeHtml(nft.collection_name || nft.collection)}</div>
          </div>
        `
        card.addEventListener("click", () => selectNFT(nft))
        gallery.appendChild(card)
      }
    } catch {
      gallery.innerHTML = '<p class="error-text">Failed to load NFTs. Please refresh and try again.</p>'
    }
  }

  async function selectNFT(nft) {
    state.selectedNft = nft

    // Highlight selected
    document.querySelectorAll(".nft-card").forEach((el) => el.classList.remove("selected"))
    const sel = document.querySelector(
      `.nft-card[data-token-id="${nft.token_id}"][data-collection="${nft.collection}"]`,
    )
    if (sel) sel.classList.add("selected")

    try {
      const res = await apiFetch(
        `/api/v1/onboarding/${state.sessionId}/select-nft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ collection: nft.collection, token_id: nft.token_id }),
        },
      )

      if (!res.ok) throw new Error("Failed to select NFT")

      // Load personality
      const persRes = await apiFetch(
        `/api/v1/onboarding/${state.sessionId}/personality`,
        { method: "POST" },
      )

      if (persRes.ok) {
        state.personality = await persRes.json()
        const card = $("#preview-card")
        if (card && state.personality) {
          card.setAttribute("archetype", state.personality.archetype || "")
          card.setAttribute("display-name", state.personality.display_name || "")
          card.setAttribute("voice", state.personality.voice_description || "")
        }
      }

      goToStep(3)
    } catch {
      // Stay on step 2
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Personality Preview
  // -------------------------------------------------------------------------

  function acceptPersonality() {
    goToStep(4)
  }

  // -------------------------------------------------------------------------
  // Step 4: Credits
  // -------------------------------------------------------------------------

  async function selectCreditPack(pack) {
    document.querySelectorAll(".credit-pack").forEach((el) => el.classList.remove("selected"))
    const sel = document.querySelector(`.credit-pack[data-pack="${pack}"]`)
    if (sel) sel.classList.add("selected")

    try {
      await apiFetch(
        `/api/v1/onboarding/${state.sessionId}/credits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pack, acknowledged: true }),
        },
      )
    } catch {
      // Best effort
    }

    goToStep(5)
  }

  function skipCredits() {
    apiFetch(`/api/v1/onboarding/${state.sessionId}/credits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pack: "none", acknowledged: true }),
    }).catch(() => {})

    goToStep(5)
  }

  // -------------------------------------------------------------------------
  // Step 5: First Message
  // -------------------------------------------------------------------------

  async function sendFirstMessage() {
    let text = $("#first-message").value.trim()
    if (!text) text = "Hello! Tell me about yourself."

    try {
      await apiFetch(`/api/v1/onboarding/${state.sessionId}/complete`, { method: "POST" })
    } catch {
      // Complete anyway
    }

    // Redirect to chat with the first message as a query param
    const nft = state.selectedNft
    if (nft) {
      const chatUrl = `/chat/${encodeURIComponent(nft.collection)}/${encodeURIComponent(nft.token_id)}`
      window.location.href = chatUrl
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function apiFetch(url, options = {}) {
    const headers = { ...options.headers }
    if (state.jwt) {
      headers["Authorization"] = `Bearer ${state.jwt}`
    }
    return fetch(url, { ...options, headers })
  }

  function escapeHtml(s) {
    const d = document.createElement("div")
    d.textContent = s
    return d.innerHTML
  }

  function escapeAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }

  // -------------------------------------------------------------------------
  // Event Binding
  // -------------------------------------------------------------------------

  function init() {
    // Check for existing JWT
    const existingJwt = localStorage.getItem("finn_jwt")
    if (existingJwt) {
      state.jwt = existingJwt
    }

    // Step 1: Wallet buttons
    const btnMetamask = $("#btn-metamask")
    const btnInjected = $("#btn-injected")
    if (btnMetamask) btnMetamask.addEventListener("click", () => connectWallet("metamask"))
    if (btnInjected) btnInjected.addEventListener("click", () => connectWallet("injected"))

    // Step 3: Accept personality
    const btnAccept = $("#btn-accept-personality")
    if (btnAccept) btnAccept.addEventListener("click", acceptPersonality)

    // Step 4: Credit packs
    document.querySelectorAll(".credit-pack").forEach((el) => {
      el.addEventListener("click", () => selectCreditPack(el.dataset.pack))
    })
    const btnSkip = $("#btn-skip-credits")
    if (btnSkip) btnSkip.addEventListener("click", skipCredits)

    // Step 5: Suggested prompts
    document.querySelectorAll(".btn-prompt").forEach((el) => {
      el.addEventListener("click", () => {
        const input = $("#first-message")
        if (input) input.value = el.dataset.prompt
      })
    })
    const btnSendFirst = $("#btn-send-first")
    if (btnSendFirst) btnSendFirst.addEventListener("click", sendFirstMessage)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init)
  } else {
    init()
  }
})()
