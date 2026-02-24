/**
 * <personality-card> Web Component
 *
 * Displays agent identity for the loa-finn NFT agent platform.
 *
 * Attributes:
 *   archetype     - freetekno | milady | chicago_detroit | acidhouse
 *   element       - fire | water | air | earth
 *   display-name  - Agent display name
 *   voice         - Voice descriptor
 *   era           - Era indicator string
 *   zodiac        - Comma-separated triad (e.g. "aries,leo,sagittarius")
 */
class PersonalityCard extends HTMLElement {
  static get observedAttributes() {
    return ['archetype', 'element', 'display-name', 'voice', 'era', 'zodiac'];
  }

  static ARCHETYPES = {
    freetekno: { accent: '#4ade80', bg: '#1a472a', label: 'Freetekno' },
    milady: { accent: '#c084fc', bg: '#3b1a47', label: 'Milady' },
    chicago_detroit: { accent: '#fb923c', bg: '#472e1a', label: 'Chicago/Detroit' },
    acidhouse: { accent: '#38bdf8', bg: '#1a3847', label: 'Acid House' },
  };

  static ELEMENTS = {
    fire: { icon: '\uD83D\uDD25', animation: 'pulse' },
    water: { icon: '\uD83D\uDCA7', animation: 'ripple' },
    air: { icon: '\uD83C\uDF2C\uFE0F', animation: 'drift' },
    earth: { icon: '\uD83C\uDF0D', animation: 'gradient' },
  };

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

  _getArchetype() {
    const key = (this.getAttribute('archetype') || '').toLowerCase();
    return PersonalityCard.ARCHETYPES[key] || null;
  }

  _getElement() {
    const key = (this.getAttribute('element') || '').toLowerCase();
    return PersonalityCard.ELEMENTS[key] || null;
  }

  _getZodiacTriad() {
    const raw = this.getAttribute('zodiac') || '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  _buildGradient(archetype) {
    if (!archetype) return 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)';
    return `linear-gradient(135deg, ${archetype.bg} 0%, ${archetype.accent}22 50%, ${archetype.bg} 100%)`;
  }

  _elementAnimationCSS(elementKey) {
    const map = {
      pulse: `
        @keyframes el-pulse {
          0%, 100% { opacity: 0.15; transform: scale(1); }
          50% { opacity: 0.3; transform: scale(1.08); }
        }
        .element-overlay {
          animation: el-pulse 3s ease-in-out infinite;
        }
      `,
      ripple: `
        @keyframes el-ripple {
          0% { opacity: 0.2; transform: scale(0.95); border-radius: 50%; }
          50% { opacity: 0.35; transform: scale(1.05); border-radius: 45%; }
          100% { opacity: 0.2; transform: scale(0.95); border-radius: 50%; }
        }
        .element-overlay {
          animation: el-ripple 4s ease-in-out infinite;
        }
      `,
      drift: `
        @keyframes el-drift {
          0% { opacity: 0.15; transform: translateX(0) translateY(0); }
          33% { opacity: 0.25; transform: translateX(6px) translateY(-4px); }
          66% { opacity: 0.2; transform: translateX(-4px) translateY(3px); }
          100% { opacity: 0.15; transform: translateX(0) translateY(0); }
        }
        .element-overlay {
          animation: el-drift 5s ease-in-out infinite;
        }
      `,
      gradient: `
        @keyframes el-gradient {
          0%, 100% { opacity: 0.18; filter: hue-rotate(0deg); }
          50% { opacity: 0.28; filter: hue-rotate(30deg); }
        }
        .element-overlay {
          animation: el-gradient 6s ease-in-out infinite;
        }
      `,
    };

    const el = PersonalityCard.ELEMENTS[elementKey];
    return el ? map[el.animation] || '' : '';
  }

  _render() {
    const displayName = this.getAttribute('display-name') || 'Unknown Agent';
    const voice = this.getAttribute('voice') || '';
    const era = this.getAttribute('era') || '';
    const elementKey = (this.getAttribute('element') || '').toLowerCase();
    const archetypeKey = (this.getAttribute('archetype') || '').toLowerCase();

    const archetype = this._getArchetype();
    const element = this._getElement();
    const zodiac = this._getZodiacTriad();

    const accent = archetype ? archetype.accent : '#888';
    const bg = archetype ? archetype.bg : '#1a1a2e';
    const archetypeLabel = archetype ? archetype.label : archetypeKey || 'None';
    const elementIcon = element ? element.icon : '';
    const elementLabel = elementKey
      ? elementKey.charAt(0).toUpperCase() + elementKey.slice(1)
      : '';

    const gradient = this._buildGradient(archetype);
    const animCSS = this._elementAnimationCSS(elementKey);

    const zodiacHTML = zodiac.length
      ? zodiac
          .map(
            (z) =>
              `<span class="zodiac-sign">${z.charAt(0).toUpperCase() + z.slice(1)}</span>`
          )
          .join('<span class="zodiac-sep">/</span>')
      : '<span class="zodiac-empty">No triad</span>';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          contain: content;
        }

        .card {
          position: relative;
          overflow: hidden;
          background: ${gradient};
          border: 1px solid ${accent}44;
          border-radius: 16px;
          padding: 24px;
          color: #e2e8f0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 360px;
          box-shadow: 0 4px 24px ${accent}1a, inset 0 1px 0 ${accent}22;
          transition: box-shadow 0.3s ease, border-color 0.3s ease;
        }

        .card:hover {
          border-color: ${accent}88;
          box-shadow: 0 8px 32px ${accent}33, inset 0 1px 0 ${accent}44;
        }

        .element-overlay {
          position: absolute;
          top: -30%;
          right: -30%;
          width: 80%;
          height: 80%;
          background: radial-gradient(circle, ${accent}20 0%, transparent 70%);
          pointer-events: none;
          z-index: 0;
        }

        ${animCSS}

        .content {
          position: relative;
          z-index: 1;
        }

        .display-name {
          margin: 0 0 16px 0;
          font-size: 1.4em;
          font-weight: 700;
          color: #f8fafc;
          letter-spacing: -0.01em;
          line-height: 1.2;
        }

        .badges {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 16px;
        }

        .badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 12px;
          border-radius: 999px;
          font-size: 0.78em;
          font-weight: 600;
          letter-spacing: 0.03em;
          text-transform: uppercase;
          white-space: nowrap;
        }

        .badge-archetype {
          background: ${accent}22;
          color: ${accent};
          border: 1px solid ${accent}44;
        }

        .badge-element {
          background: ${accent}15;
          color: ${accent}cc;
          border: 1px solid ${accent}33;
        }

        .badge-element .icon {
          font-size: 1.1em;
        }

        .section {
          margin-bottom: 12px;
        }

        .section-label {
          font-size: 0.7em;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #94a3b8;
          margin-bottom: 4px;
        }

        .zodiac-row {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }

        .zodiac-sign {
          font-size: 0.88em;
          color: ${accent}dd;
          font-weight: 500;
        }

        .zodiac-sep {
          color: #475569;
          font-size: 0.8em;
        }

        .zodiac-empty {
          color: #475569;
          font-size: 0.85em;
          font-style: italic;
        }

        .era-value {
          font-size: 0.88em;
          color: #cbd5e1;
          font-weight: 500;
        }

        .voice-value {
          font-size: 0.85em;
          color: #94a3b8;
          font-style: italic;
        }

        .divider {
          border: none;
          border-top: 1px solid ${accent}1a;
          margin: 14px 0;
        }
      </style>

      <div class="card">
        <div class="element-overlay"></div>
        <div class="content">
          <h2 class="display-name">${this._esc(displayName)}</h2>

          <div class="badges">
            <span class="badge badge-archetype">${this._esc(archetypeLabel)}</span>
            ${
              elementLabel
                ? `<span class="badge badge-element"><span class="icon">${elementIcon}</span> ${this._esc(elementLabel)}</span>`
                : ''
            }
          </div>

          ${
            zodiac.length || era || voice
              ? '<hr class="divider">'
              : ''
          }

          ${
            zodiac.length
              ? `
            <div class="section">
              <div class="section-label">Zodiac Triad</div>
              <div class="zodiac-row">${zodiacHTML}</div>
            </div>
          `
              : ''
          }

          ${
            era
              ? `
            <div class="section">
              <div class="section-label">Era</div>
              <div class="era-value">${this._esc(era)}</div>
            </div>
          `
              : ''
          }

          ${
            voice
              ? `
            <div class="section">
              <div class="section-label">Voice</div>
              <div class="voice-value">${this._esc(voice)}</div>
            </div>
          `
              : ''
          }
        </div>
      </div>
    `;
  }

  /** Basic HTML escaping to prevent injection in attribute values. */
  _esc(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }
}

customElements.define('personality-card', PersonalityCard);
