/**
 * <reputation-badge> Web Component
 *
 * Displays trust state as a 4-segment progress bar for the loa-finn NFT agent platform.
 *
 * Attributes:
 *   state - cold | warming | established | authoritative
 *   score - Number 0-100
 */
class ReputationBadge extends HTMLElement {
  static get observedAttributes() {
    return ['state', 'score'];
  }

  static STATES = [
    { key: 'cold', label: 'Cold', color: '#6b7280', colorLight: '#9ca3af' },
    { key: 'warming', label: 'Warming', color: '#3b82f6', colorLight: '#60a5fa' },
    { key: 'established', label: 'Established', color: '#22c55e', colorLight: '#4ade80' },
    { key: 'authoritative', label: 'Authoritative', color: '#eab308', colorLight: '#facc15' },
  ];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this._render();
  }

  attributeChangedCallback() {
    if (this.shadowRoot) {
      this._render();
    }
  }

  _getStateIndex() {
    const raw = (this.getAttribute('state') || '').toLowerCase();
    const idx = ReputationBadge.STATES.findIndex((s) => s.key === raw);
    return idx >= 0 ? idx : 0;
  }

  _getScore() {
    const raw = this.getAttribute('score');
    if (raw === null || raw === '') return 0;
    const n = Number(raw);
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  _render() {
    const states = ReputationBadge.STATES;
    const currentIdx = this._getStateIndex();
    const score = this._getScore();
    const currentState = states[currentIdx];
    const nextState = currentIdx < states.length - 1 ? states[currentIdx + 1] : null;

    const segmentsHTML = states
      .map((s, i) => {
        let cls = 'segment';
        if (i < currentIdx) cls += ' segment-filled';
        else if (i === currentIdx) cls += ' segment-active';
        else if (i === currentIdx + 1) cls += ' segment-next';
        else cls += ' segment-locked';

        return `
          <div class="${cls}" style="
            --seg-color: ${s.color};
            --seg-color-light: ${s.colorLight};
          ">
            <div class="segment-bar"></div>
            <div class="segment-label">${s.label}</div>
          </div>
        `;
      })
      .join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          contain: content;
        }

        .container {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #0f172a;
          border: 1px solid #1e293b;
          border-radius: 12px;
          padding: 20px;
          max-width: 400px;
          color: #e2e8f0;
        }

        .header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 16px;
        }

        .title {
          font-size: 0.75em;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #94a3b8;
        }

        .score {
          font-size: 1.5em;
          font-weight: 700;
          color: ${currentState.colorLight};
          line-height: 1;
        }

        .score-pct {
          font-size: 0.5em;
          font-weight: 400;
          color: ${currentState.color};
        }

        .progress {
          display: flex;
          gap: 4px;
          margin-bottom: 14px;
        }

        .segment {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .segment-bar {
          height: 8px;
          border-radius: 4px;
          background: #1e293b;
          position: relative;
          overflow: hidden;
          transition: background 0.4s ease;
        }

        .segment-filled .segment-bar {
          background: var(--seg-color);
          box-shadow: 0 0 8px var(--seg-color-light, var(--seg-color));
        }

        .segment-active .segment-bar {
          background: var(--seg-color);
          box-shadow: 0 0 12px var(--seg-color-light, var(--seg-color));
          animation: active-glow 2s ease-in-out infinite;
        }

        .segment-next .segment-bar {
          background: linear-gradient(
            90deg,
            var(--seg-color) 0%,
            transparent 100%
          );
          opacity: 0.25;
        }

        .segment-locked .segment-bar {
          background: #1e293b;
        }

        @keyframes active-glow {
          0%, 100% {
            box-shadow: 0 0 8px var(--seg-color-light, var(--seg-color));
          }
          50% {
            box-shadow: 0 0 16px var(--seg-color-light, var(--seg-color));
          }
        }

        .segment-label {
          font-size: 0.65em;
          text-align: center;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-weight: 500;
          color: #475569;
          transition: color 0.3s ease;
        }

        .segment-filled .segment-label {
          color: var(--seg-color);
          opacity: 0.7;
        }

        .segment-active .segment-label {
          color: var(--seg-color-light);
          font-weight: 700;
        }

        .segment-next .segment-label {
          color: var(--seg-color);
          opacity: 0.35;
        }

        .footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 4px;
        }

        .current-state {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 0.82em;
          font-weight: 600;
          color: ${currentState.colorLight};
        }

        .state-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: ${currentState.color};
          box-shadow: 0 0 6px ${currentState.colorLight};
          animation: dot-pulse 2s ease-in-out infinite;
        }

        @keyframes dot-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .next-unlock {
          font-size: 0.72em;
          color: #475569;
        }

        .next-unlock-name {
          color: ${nextState ? nextState.color : '#475569'};
          opacity: 0.6;
          font-weight: 600;
        }
      </style>

      <div class="container">
        <div class="header">
          <span class="title">Reputation</span>
          <span class="score">${score}<span class="score-pct">%</span></span>
        </div>

        <div class="progress">
          ${segmentsHTML}
        </div>

        <div class="footer">
          <span class="current-state">
            <span class="state-dot"></span>
            ${currentState.label}
          </span>
          ${
            nextState
              ? `<span class="next-unlock">Next: <span class="next-unlock-name">${nextState.label}</span></span>`
              : '<span class="next-unlock" style="color: #eab308; opacity: 0.8;">Max rank</span>'
          }
        </div>
      </div>
    `;
  }
}

customElements.define('reputation-badge', ReputationBadge);
