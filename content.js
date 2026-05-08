(function () {
  'use strict';

  // Selectors for every video-card variant YouTube uses across page layouts.
  const CARD_SELECTORS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-rich-grid-media',
    'ytd-reel-item-renderer',
  ].join(',');

  // ---- State ---------------------------------------------------------------

  let pinnedCard         = null;  // card element currently pinned
  let hiddenBlocker      = null;  // MutationObserver keeping the preview visible
  let currentPreviewCard = null;  // card whose preview is currently showing
  let pinnedNaturalW     = 0;     // unscaled offsetWidth recorded at pin time

  // page_shim.js runs in world:"MAIN" at document_start (manifest.json).
  // We communicate via synchronous CustomEvent: dispatchEvent runs all handlers
  // inline before returning, ensuring page_shim.js state is set before any CSS
  // change that might move ytd-video-preview under the cursor.

  // ---- Utilities -----------------------------------------------------------

  const getPreviewEl     = () => document.querySelector('ytd-video-preview');
  const isPreviewVisible = () => { const vp = getPreviewEl(); return vp && !vp.hasAttribute('hidden'); };
  const findCard         = (el) => el?.closest?.(CARD_SELECTORS) ?? null;
  const isShortCard      = (card) =>
    !!card.querySelector('ytm-shorts-lockup-view-model') ||
    !!card.querySelector('a[href*="/shorts/"]');

  // Fill up to 80% of the viewport width, capped at 1200 px.
  // naturalW is the element's offsetWidth *before* ytpp-pinned is applied.
  function computePinScale(naturalW) {
    const targetW = Math.min(window.innerWidth * 0.80, 1200);
    return Math.max(1.1, targetW / naturalW);
  }

  // ---- DOM setup -----------------------------------------------------------

  const backdrop = document.createElement('div');
  backdrop.id = 'ytpp-backdrop';
  document.body.appendChild(backdrop);

  const controls = document.createElement('div');
  controls.id = 'ytpp-controls';
  const unpinBtn = document.createElement('button');
  unpinBtn.className = 'ytpp-unpin-btn';
  unpinBtn.textContent = '📌 Unpin';
  controls.appendChild(unpinBtn);

  // ---- Preview card tracking -----------------------------------------------

  document.addEventListener('mouseenter', (e) => {
    if (pinnedCard) return;
    const card = findCard(e.target);
    if (!card) return;
    if (isShortCard(card)) {
      document.body.classList.add('ytpp-on-short');
    } else {
      document.body.classList.remove('ytpp-on-short');
      currentPreviewCard = card;
    }
  }, true);

  // ---- Pin button ----------------------------------------------------------

  function ensurePinButton() {
    const vp = getPreviewEl();
    if (!vp || vp.querySelector('.ytpp-pin-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'ytpp-pin-btn';
    btn.textContent = '📌 Pin';
    vp.appendChild(btn);
  }

  function ensureControls() {
    const vp = getPreviewEl();
    if (!vp || vp.querySelector('#ytpp-controls')) return;
    vp.appendChild(controls);
  }

  ensurePinButton();
  ensureControls();

  // Re-inject buttons if YouTube reconstructs ytd-video-preview outside of
  // a full navigation (e.g. player state changes, lazy DOM updates).
  new MutationObserver((mutations) => {
    for (const { addedNodes } of mutations) {
      for (const node of addedNodes) {
        if (node.nodeType === 1 && node.tagName === 'YTD-VIDEO-PREVIEW') {
          ensurePinButton();
          ensureControls();
          return;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ---- Hidden-attribute guard ----------------------------------------------
  // Watches ytd-video-preview and all descendants
  // for hidden / display:none / visibility:hidden / opacity:0 set via inline
  // style and immediately reverts them while pinned.

  function startBlockingHidden(vp) {
    stopBlockingHidden();
    hiddenBlocker = new MutationObserver((mutations) => {
      for (const { attributeName, target: el } of mutations) {
        if (attributeName === 'hidden' && el.hasAttribute('hidden')) {
          el.removeAttribute('hidden');
        }
        if (attributeName === 'style') {
          if (el.style.display    === 'none')   el.style.display    = '';
          if (el.style.visibility === 'hidden') el.style.visibility = '';
          if (el.style.opacity    === '0')      el.style.opacity    = '';
        }
      }
    });
    hiddenBlocker.observe(vp, {
      attributes: true,
      attributeFilter: ['hidden', 'style'],
      subtree: true,
    });
  }

  function stopBlockingHidden() {
    hiddenBlocker?.disconnect();
    hiddenBlocker = null;
  }

  // ---- Pin / Unpin ---------------------------------------------------------

  function pin(card, disableCaptions = true) {
    if (pinnedCard === card) return;
    if (pinnedCard) unpin();

    const vp = getPreviewEl();
    if (!vp) return;

    pinnedCard = card;
    card.classList.add('ytpp-pinned-card');

    // Arm page_shim.js synchronously BEFORE the element moves.
    document.dispatchEvent(new CustomEvent('ytpp-pin', { detail: { disableCaptions } }));

    // Measure before ytpp-pinned so position:fixed doesn't change the width.
    pinnedNaturalW = vp.offsetWidth || Math.round(window.innerWidth * 0.25);
    document.documentElement.style.setProperty('--ytpp-scale', computePinScale(pinnedNaturalW));

    document.body.classList.add('ytpp-active');
    vp.classList.add('ytpp-pinned');
    startBlockingHidden(vp);
  }

  function unpin() {
    if (!pinnedCard) return;

    // Disarm page_shim.js BEFORE removing CSS classes so any mouseleave that
    // fires when the element snaps back doesn't hit the guard on stale state.
    document.dispatchEvent(new CustomEvent('ytpp-unpin'));

    pinnedCard.classList.remove('ytpp-pinned-card');
    document.body.classList.remove('ytpp-active', 'ytpp-controls-active');
    pinnedCard     = null;
    pinnedNaturalW = 0;
    stopBlockingHidden();

    const vp = getPreviewEl();
    if (vp) vp.classList.remove('ytpp-pinned');
    document.documentElement.style.removeProperty('--ytpp-scale');
  }

  // ---- Event listeners -----------------------------------------------------

  // Pin / unpin via the injected button, or unpin by clicking the backdrop.
  document.addEventListener('click', (e) => {
    if (e.button !== 0) return;

    if (e.target.closest?.('.ytpp-unpin-btn')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      unpin();
      return;
    }

    if (e.target.closest?.('.ytpp-pin-btn')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (pinnedCard) {
        unpin();
      } else if (currentPreviewCard && isPreviewVisible()) {
        const card = currentPreviewCard;
        chrome.storage.sync.get({ disableCaptionsOnPin: true }, ({ disableCaptionsOnPin }) => {
          if (card === currentPreviewCard && document.contains(card) && isPreviewVisible()) pin(card, disableCaptionsOnPin);
        });
      }
      return;
    }

    if (pinnedCard) {
      const vp = getPreviewEl();
      if (!pinnedCard.contains(e.target) && !vp?.contains(e.target)) {
        // Stop propagation so YouTube doesn't see a click on our backdrop element
        // and corrupt state, preventing the next pin attempt from working.
        e.stopPropagation();
        e.preventDefault();
        unpin();
      }
      return;
    }
  }, true);

  // Secondary JS guard against YouTube's hover handlers on non-pinned cards.
  // CSS pointer-events:none on those cards is the primary guard; this covers
  // any events that still slip through.
  for (const type of ['mouseenter', 'mouseover']) {
    document.addEventListener(type, (e) => {
      if (!pinnedCard) return;
      const other = findCard(e.target);
      if (other && other !== pinnedCard) e.stopImmediatePropagation();
    }, true);
  }

  // Escape key unpins.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pinnedCard) {
      e.preventDefault();
      unpin();
    }
  });

  // Resize: recompute scale using the stored natural width so we never need to
  // remove ytpp-pinned (which would disturb YouTube's player state).
  window.addEventListener('resize', () => {
    if (!pinnedCard || !pinnedNaturalW) return;
    document.documentElement.style.setProperty('--ytpp-scale', computePinScale(pinnedNaturalW));
  });

  // SPA navigation: unpin and re-inject the button after YouTube rebuilds the DOM.
  document.addEventListener('yt-navigate-start', () => {
    unpin();
    document.body.classList.remove('ytpp-on-short');
  });
  document.addEventListener('yt-navigate-finish', () => {
    unpin();
    ensurePinButton();
    ensureControls();
  });

})();
