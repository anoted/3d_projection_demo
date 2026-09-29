const CARD_W_MM = 85.6;
const CARD_H_MM = 53.98;

/**
 * Physical-size calibration. Browsers can't report DPI reliably, so the user
 * matches an on-screen rectangle to a real bank card, or enters their diagonal.
 * Resolves with millimeters per *device* pixel (independent of browser zoom), or null.
 */
export function openCalibration(currentMmPerCssPx) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'calib';
    root.innerHTML = `
      <div class="calib-panel" role="dialog" aria-modal="true" aria-labelledby="calib-title">
        <h2 id="calib-title">Calibrate physical size</h2>
        <p>Hold a bank card (85.6 × 54 mm) flat against the screen and resize the rectangle until it matches the card's edges exactly.</p>
        <div class="card-area"><div class="card"><div class="card-chip"></div><div class="card-handle" title="Drag to resize"></div></div></div>
        <div class="calib-row">
          <button data-step="-1" aria-label="Smaller">−</button>
          <input type="range" min="120" max="900" step="0.5" aria-label="Card width in pixels">
          <button data-step="1" aria-label="Larger">+</button>
          <output></output>
        </div>
        <details>
          <summary>Or enter your display's diagonal</summary>
          <div class="calib-row">
            <label>Diagonal <input type="number" class="diag" min="5" max="120" step="0.1" placeholder="e.g. 15.6"> in</label>
            <button class="use-diag">Use diagonal</button>
          </div>
          <p class="hint">Uses the display's native resolution (${Math.round(screen.width * devicePixelRatio)} × ${Math.round(screen.height * devicePixelRatio)} px). Assumes square pixels.</p>
        </details>
        <div class="calib-actions">
          <button class="cancel">Cancel</button>
          <button class="save primary">Save</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    const card = root.querySelector('.card');
    const range = root.querySelector('input[type=range]');
    const out = root.querySelector('output');
    let widthPx = CARD_W_MM / currentMmPerCssPx;

    const set = (px) => {
      widthPx = Math.min(900, Math.max(120, px));
      card.style.width = `${widthPx}px`;
      card.style.height = `${(widthPx * CARD_H_MM) / CARD_W_MM}px`;
      range.value = widthPx;
      out.textContent = `${(CARD_W_MM / widthPx).toFixed(4)} mm/px`;
    };
    set(widthPx);

    range.addEventListener('input', () => set(+range.value));
    root.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => set(widthPx + +b.dataset.step * 0.5)));

    const handle = root.querySelector('.card-handle');
    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = widthPx;
      const move = (ev) => set(w0 + (ev.clientX - x0));
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });

    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') set(widthPx + (e.shiftKey ? 5 : 0.5));
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') set(widthPx - (e.shiftKey ? 5 : 0.5));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);

    const finish = (value) => {
      window.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(value);
    };
    root.querySelector('.cancel').addEventListener('click', () => finish(null));
    root.querySelector('.save').addEventListener('click', () => finish(CARD_W_MM / widthPx / devicePixelRatio));
    root.querySelector('.use-diag').addEventListener('click', () => {
      const inches = parseFloat(root.querySelector('.diag').value);
      if (!(inches > 0)) return;
      const nativeDiagPx = Math.hypot(screen.width * devicePixelRatio, screen.height * devicePixelRatio);
      finish((inches * 25.4) / nativeDiagPx);
    });
  });
}
