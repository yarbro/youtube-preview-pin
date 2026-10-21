(function () {
  'use strict';

  const YT = {
    PREVIEW:       'ytd-video-preview',
    PREVIEW_VIDEO: 'ytd-video-preview video',
    CARDS: [
      'ytd-rich-item-renderer',
      'ytd-video-renderer',
      'ytd-grid-video-renderer',
      'ytd-compact-video-renderer',
      'ytd-rich-grid-media',
      'ytd-reel-item-renderer',
      'yt-lockup-view-model', // current card element; the ytd-* renderers above are legacy
    ].join(','),
    SHORT_CARD: 'ytm-shorts-lockup-view-model, a[href*="/shorts/"]',
    // Current previews stay in the DOM and toggle these classes instead of
    // the legacy `hidden` attribute.
    PREVIEW_HOST:   'ytdVideoPreviewHost',
    PREVIEW_ACTIVE: 'ytdVideoPreviewActive',
  };

  // page_shim.js runs in world:"MAIN" at document_start. We communicate via
  // synchronous CustomEvents — dispatchEvent runs all handlers inline so
  // page_shim.js state is set before the CSS change that moves the preview.

  // ---- State ---------------------------------------------------------------

  let pinnedCard         = null;
  let pinnedVP           = null; // the ytd-video-preview element captured at pin time
  let pinnedIsLive       = false;
  let hiddenBlocker      = null;
  let currentPreviewCard = null;
  let pinnedNaturalW     = 0;
  let pinnedNaturalH     = 0;
  let previewPaused      = false;
  let scrubVideo         = null;
  let timeupdateFn       = null;
  let durationChangeFn   = null;
  let videoEndedFn       = null;
  let seekingContentFn   = null;
  let scrubbing          = false;
  let scrubEndThreshold  = Infinity; // VOD duration at pin time; Infinity for live
  let lastKnownTime      = 0;
  let scrubAliveRafId    = null;
  let controlsFlashTimer = null;

  // ---- Utilities -----------------------------------------------------------

  const getPreviewEl     = () => document.querySelector(YT.PREVIEW);
  const isPreviewVisible = () => {
    const vp = getPreviewEl();
    if (!vp || vp.hasAttribute('hidden')) return false;
    return !vp.classList.contains(YT.PREVIEW_HOST) || vp.classList.contains(YT.PREVIEW_ACTIVE);
  };
  const findCard         = (el) => el?.closest?.(YT.CARDS) ?? null;
  const isShortCard      = (card) => !!card.querySelector(YT.SHORT_CARD);

  // naturalW/H are the offset size before ytpp-pinned applies position:fixed.
  // Fit both dimensions so a short, wide window doesn't push the preview's
  // top and bottom off screen.
  function computePinScale(naturalW, naturalH) {
    const targetW = Math.min(window.innerWidth * 0.80, 1200);
    const targetH = window.innerHeight * 0.85;
    return Math.max(1.1, Math.min(targetW / naturalW, targetH / naturalH));
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const t = Math.floor(seconds);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // ---- DOM setup -----------------------------------------------------------

  // Material Symbols paths (24×24 viewBox). SVG instead of emoji so the
  // icons render the same on every OS.
  const ICONS = {
    pin:   'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z',
    play:  'M8 5.14v13.72c0 .79.87 1.27 1.54.84l10.78-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z',
    pause: 'M7 5h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm7 0h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
    close: 'M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4z',
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ytpp-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // Backdrop, close button and shortcut hints live on <body>; only the
  // playback bar goes inside the pinned preview.
  const backdrop = createEl('div');
  backdrop.id = 'ytpp-backdrop';
  document.body.appendChild(backdrop);

  const unpinBtn = createEl('button', 'ytpp-unpin-btn');
  unpinBtn.appendChild(icon('close'));
  unpinBtn.title = 'Unpin (Esc)';
  unpinBtn.setAttribute('aria-label', 'Unpin');
  document.body.appendChild(unpinBtn);

  const hints = createEl('div', 'ytpp-hints');
  for (const [keys, action] of [[['Space'], 'Pause'], [['←', '→'], 'Seek'], [['Esc'], 'Close']]) {
    const hint = createEl('span', 'ytpp-hint');
    for (const key of keys) hint.appendChild(createEl('kbd', '', key));
    hint.appendChild(document.createTextNode(action));
    hints.appendChild(hint);
  }
  document.body.appendChild(hints);

  const controls = createEl('div');
  controls.id = 'ytpp-controls';

  const pauseBtn = createEl('button', 'ytpp-pause-btn');
  setPauseState(false);
  controls.appendChild(pauseBtn);

  const scrubberLabel = createEl('span', 'ytpp-scrubber-label', '0:00');
  controls.appendChild(scrubberLabel);
  controls.appendChild(createEl('span', 'ytpp-live-badge', 'LIVE'));

  const scrubber = document.createElement('input');
  scrubber.type      = 'range';
  scrubber.className = 'ytpp-scrubber';
  scrubber.min       = '0';
  scrubber.max       = '1';
  scrubber.step      = '0.001';
  scrubber.value     = '0';
  scrubber.setAttribute('aria-label', 'Seek (← →)');
  scrubber.title     = 'Seek (← →)';
  controls.appendChild(scrubber);

  // ---- Input handlers ------------------------------------------------------

  // Track whether the most recent mousedown started inside the preview so
  // we can distinguish a drag-off release from a real backdrop click.
  let mousedownInsidePreview = false;

  scrubber.addEventListener('mousedown', () => {
    scrubbing = true;
    document.dispatchEvent(new CustomEvent('ytpp-scrub-start'));
  });

  document.addEventListener('mousedown', (e) => {
    if (!pinnedCard) return;
    const vp = getPreviewEl();
    mousedownInsidePreview = !!(vp?.contains(e.target) || controls.contains(e.target));
  }, true);

  // Capture-phase so this catches releases outside the scrubber (drag-off).
  document.addEventListener('mouseup', () => {
    if (!scrubbing) return;
    scrubbing = false;
    document.dispatchEvent(new CustomEvent('ytpp-scrub-end'));
  }, true);

  scrubber.addEventListener('input', () => {
    if (!scrubVideo) return;
    scrubVideo.currentTime = parseFloat(scrubber.value);
    updateScrubberUI();
  });

  // VOD: unpin when the scrubber is released at the end. 'ended' won't fire
  // for a paused video at currentTime === duration, and calling play() there
  // tears the player down before 'ended' can — so detect the release on the
  // scrubber directly. scrubEndThreshold is Infinity for live, never matches.
  scrubber.addEventListener('change', () => {
    if (!pinnedCard) return;
    if (parseFloat(scrubber.value) >= scrubEndThreshold - 1 ||
        (scrubEndThreshold !== Infinity && scrubVideo?.ended)) {
      unpin();
    }
  });

  // ---- Preview-card tracking -----------------------------------------------

  // Capture-phase mouseenter fires for every nested entry. Dedupe so we
  // only react on actual card transitions.
  let lastSeenCard = null;
  document.addEventListener('mouseenter', (e) => {
    if (pinnedCard) return;
    const card = findCard(e.target);
    if (card === lastSeenCard) return;
    lastSeenCard = card;
    if (!card) return;
    if (isShortCard(card)) {
      document.body.classList.add('ytpp-on-short');
    } else {
      document.body.classList.remove('ytpp-on-short');
      currentPreviewCard = card;
    }
  }, true);

  // ---- Button injection ----------------------------------------------------

  function ensurePinButton() {
    const vp = getPreviewEl();
    if (!vp || vp.querySelector('.ytpp-pin-btn')) return;
    const btn = createEl('button', 'ytpp-pin-btn');
    btn.append(icon('pin'), 'Pin');
    btn.title = 'Pin this preview so it keeps playing';
    vp.appendChild(btn);
  }

  function ensureControls() {
    const vp = getPreviewEl();
    if (!vp || vp.querySelector('#ytpp-controls')) return;
    vp.appendChild(controls);
  }

  ensurePinButton();
  ensureControls();

  // YouTube reconstructs the preview outside of a full navigation (lazy DOM
  // updates), so re-inject buttons whenever the DOM changes. Debounced to one
  // check per frame; ensure* early-return cheaply when nothing is missing.
  // This also catches a preview inserted as a descendant of an added node,
  // which per-addedNode tag matching would miss.
  let ensureScheduled = false;
  function scheduleEnsure() {
    if (ensureScheduled) return;
    ensureScheduled = true;
    requestAnimationFrame(() => {
      ensureScheduled = false;
      ensurePinButton();
      ensureControls();
    });
  }
  new MutationObserver(scheduleEnsure)
    .observe(document.body, { childList: true, subtree: true });

  // ---- Hidden-element guard ------------------------------------------------
  // Reverts hidden / display:none / visibility:hidden / opacity:0 applied
  // anywhere in the pinned preview subtree, and detects structural teardown
  // (the inline player removing its own children) so we can unpin gracefully.

  function startBlockingHidden(vp) {
    stopBlockingHidden();
    hiddenBlocker = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        if (mut.type === 'childList') {
          let teardownTag = false;
          for (const n of mut.removedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'YT-PROGRESS-BAR' ||
                n.tagName === 'YTD-PLAYER'      ||
                n.tagName === 'YTD-THUMBNAIL') {
              teardownTag = true;
              break;
            }
          }
          // Only treat as teardown for VOD; ignore during a scrub drag, when
          // seek-induced element churn is expected.
          if (pinnedCard && scrubEndThreshold !== Infinity && !scrubbing && teardownTag) {
            unpin();
            return;
          }
          if (!scrubbing && scrubVideo && !scrubVideo.isConnected &&
              lastKnownTime >= scrubEndThreshold - 0.5) {
            unpin();
            return;
          }
          // YouTube sometimes swaps the <video> element in place (source
          // reload, quality switch). Once the old element is detached and a
          // replacement exists, re-bind the scrubber and the page_shim
          // guards so they don't keep tracking the dead one.
          if (pinnedCard && scrubVideo && !scrubbing && !scrubVideo.isConnected) {
            const video = document.querySelector(YT.PREVIEW_VIDEO);
            if (video && video !== scrubVideo) {
              rebindVideo();
              return;
            }
          }
          continue;
        }
        const { attributeName, target: el } = mut;
        if (attributeName === 'hidden' && el.hasAttribute('hidden')) {
          el.removeAttribute('hidden');
        }
        if (attributeName === 'style') {
          if (el.style.display    === 'none')      el.style.display    = '';
          if (el.style.visibility === 'hidden')    el.style.visibility = '';
          if (parseFloat(el.style.opacity) === 0)  el.style.opacity    = '';
        }
      }
    });
    hiddenBlocker.observe(vp, {
      attributes:      true,
      attributeFilter: ['hidden', 'style'],
      childList:       true,
      subtree:         true,
    });
  }

  function stopBlockingHidden() {
    hiddenBlocker?.disconnect();
    hiddenBlocker = null;
  }

  // ---- Scrubber ------------------------------------------------------------

  // Paints the played portion of the track from the scrubber's current
  // value/range (Chrome can't style a range input's lower track natively),
  // and sets the label: "1:23 / 10:45" for VOD, "1:23" plus the LIVE badge
  // for live streams.
  function updateScrubberUI() {
    const min = parseFloat(scrubber.min) || 0;
    const max = parseFloat(scrubber.max);
    const progress = max > min ? (parseFloat(scrubber.value) - min) / (max - min) : 0;
    scrubber.style.setProperty('--ytpp-progress', `${Math.max(0, Math.min(1, progress)) * 100}%`);

    if (!scrubVideo) { scrubberLabel.textContent = '0:00'; return; }
    const cur = formatTime(scrubVideo.currentTime);
    if (pinnedIsLive) {
      scrubberLabel.textContent = cur;
      return;
    }
    const dur = isFinite(scrubVideo.duration) ? scrubVideo.duration : scrubEndThreshold;
    scrubberLabel.textContent = isFinite(dur) ? `${cur} / ${formatTime(dur)}` : cur;
  }

  // Keyboard seek (← →). Clamps to the scrubber's range so the VOD
  // stop-1s-short-of-the-end teardown guard applies to key seeks too.
  function seekBy(delta) {
    if (!scrubVideo) return;
    const min = parseFloat(scrubber.min) || 0;
    const max = parseFloat(scrubber.max);
    const target = Math.max(min, Math.min(isFinite(max) ? max : Infinity,
                                          scrubVideo.currentTime + delta));
    scrubVideo.currentTime = target;
    scrubber.value = String(target);
    updateScrubberUI();
    flashControls();
  }

  function attachScrubber(isLive) {
    const video = document.querySelector(YT.PREVIEW_VIDEO);
    if (!video) return;
    scrubVideo = video;

    // VOD: full duration; Live: the seekable DVR window, which advances in
    // real time so we re-sync on every timeupdate.
    function syncRange() {
      if (isLive) {
        const s = scrubVideo.seekable;
        if (s.length > 0) {
          scrubber.min = String(s.start(0));
          scrubber.max = String(s.end(s.length - 1));
        }
      } else if (isFinite(scrubVideo.duration)) {
        // Stop 1 s short of the end so dragging into the teardown zone is
        // impossible. The final second plays out naturally and videoEndedFn
        // handles the unpin.
        scrubber.max = String(Math.max(0, scrubVideo.duration - 1));
      }
    }

    // Captured at pin time so the change handler can still detect a
    // scrub-to-end even if YouTube has destroyed the video element by then.
    scrubEndThreshold = isLive ? Infinity : (isFinite(video.duration) ? video.duration : Infinity);

    syncRange();
    scrubber.value = String(video.currentTime);
    updateScrubberUI();

    // 'seeking' fires with the target before timeupdate catches up, so this
    // keeps lastKnownTime current right up to the moment of teardown.
    seekingContentFn = () => { lastKnownTime = video.currentTime; };
    video.addEventListener('seeking', seekingContentFn);

    timeupdateFn = () => {
      lastKnownTime = scrubVideo.currentTime;
      if (isLive) syncRange();
      if (!scrubbing) {
        scrubber.value = String(scrubVideo.currentTime);
        updateScrubberUI();
      }
    };

    durationChangeFn = () => {
      syncRange();
      // duration may have been NaN at pin time — backfill the threshold now.
      if (!isLive && isFinite(scrubVideo.duration) && scrubEndThreshold === Infinity) {
        scrubEndThreshold = scrubVideo.duration;
      }
    };

    videoEndedFn = () => {
      if (isLive) {
        // Live edge reached: seek back 3 s so there's buffered content.
        const s = scrubVideo?.seekable;
        if (s?.length > 0) scrubVideo.currentTime = Math.max(s.start(0), s.end(s.length - 1) - 3);
      } else if (!scrubbing) {
        unpin();
      }
    };

    video.addEventListener('timeupdate',     timeupdateFn);
    video.addEventListener('durationchange', durationChangeFn);
    video.addEventListener('ended',          videoEndedFn);

    // After a seek to the end of a VOD, 'ended' and 'seeked' may never fire
    // — the video element gets removed (or its parent replaced) first. Poll
    // for disconnection as a fallback. Mid-video disconnects either re-bind
    // to a replacement element or, if none appears, close the pin gracefully
    // instead of leaving an empty shell up.
    let disconnectedFrames = 0;
    const aliveCheck = () => {
      if (!scrubVideo) { scrubAliveRafId = null; return; }
      if (!scrubbing && !scrubVideo.isConnected) {
        if (lastKnownTime >= scrubEndThreshold - 0.5) {
          scrubAliveRafId = null;
          unpin();
          return;
        }
        const replacement = document.querySelector(YT.PREVIEW_VIDEO);
        if (replacement && replacement !== scrubVideo) {
          // rebindVideo -> attachScrubber starts a fresh aliveCheck loop.
          rebindVideo();
          return;
        }
        if (++disconnectedFrames > 90) { // ~1.5 s with no video
          scrubAliveRafId = null;
          unpin();
          return;
        }
      } else {
        disconnectedFrames = 0;
      }
      scrubAliveRafId = requestAnimationFrame(aliveCheck);
    };
    scrubAliveRafId = requestAnimationFrame(aliveCheck);
  }

  // Re-attach scrubber listeners after YouTube replaces the <video> element,
  // and tell page_shim.js to move its pause/mute guards to the new one.
  function rebindVideo() {
    detachScrubber();
    attachScrubber(pinnedIsLive);
    document.dispatchEvent(new CustomEvent('ytpp-video-changed'));
  }

  function detachScrubber() {
    if (scrubAliveRafId !== null) cancelAnimationFrame(scrubAliveRafId);
    if (scrubVideo) {
      if (timeupdateFn)     scrubVideo.removeEventListener('timeupdate',     timeupdateFn);
      if (durationChangeFn) scrubVideo.removeEventListener('durationchange', durationChangeFn);
      if (videoEndedFn)     scrubVideo.removeEventListener('ended',          videoEndedFn);
      if (seekingContentFn) scrubVideo.removeEventListener('seeking',        seekingContentFn);
    }
    scrubVideo                = null;
    timeupdateFn              = null;
    durationChangeFn          = null;
    videoEndedFn              = null;
    seekingContentFn          = null;
    scrubAliveRafId           = null;
    scrubbing                 = false;
    scrubEndThreshold         = Infinity;
    lastKnownTime             = 0;
    scrubber.min              = '0';
    scrubber.value            = '0';
    scrubber.max              = '1';
    updateScrubberUI();
  }

  // ---- Pin / Unpin ---------------------------------------------------------

  function setPauseState(paused) {
    previewPaused = paused;
    pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause'));
    pauseBtn.title = paused ? 'Play (Space)' : 'Pause (Space)';
    pauseBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }

  function togglePause() {
    const pausing = !previewPaused;
    setPauseState(pausing);
    document.dispatchEvent(new CustomEvent(pausing ? 'ytpp-pause' : 'ytpp-play'));
  }

  // Reveal the controls for a moment (on pin and on keyboard interaction) so
  // they're discoverable without hovering; CSS fades them back out.
  function flashControls(ms = 2500) {
    if (!pinnedVP) return;
    pinnedVP.setAttribute('ytpp-show-controls', '');
    clearTimeout(controlsFlashTimer);
    controlsFlashTimer = setTimeout(() => {
      pinnedVP?.removeAttribute('ytpp-show-controls');
    }, ms);
  }

  function pin(card, disableCaptions = true) {
    if (pinnedCard === card) return;
    if (pinnedCard) unpin();

    const vp = getPreviewEl();
    if (!vp) return;

    pinnedCard = card;
    pinnedVP   = vp;
    card.setAttribute('ytpp-pinned-card', '');

    // YouTube reports a finite duration even for live previews, so detect
    // live from the LIVE badge on the card instead.
    const isLive = !!card.querySelector('.ytBadgeShapeThumbnailLive');
    pinnedIsLive = isLive;
    controls.toggleAttribute('ytpp-live', isLive);

    // Arm page_shim.js synchronously before the element moves.
    document.dispatchEvent(new CustomEvent('ytpp-pin', { detail: { disableCaptions, isLive } }));

    // Measure before ytpp-pinned applies position:fixed (which would change
    // the size).
    pinnedNaturalW = vp.offsetWidth  || Math.round(window.innerWidth * 0.25);
    pinnedNaturalH = vp.offsetHeight || Math.round(pinnedNaturalW * 9 / 16);
    document.documentElement.style.setProperty('--ytpp-scale', computePinScale(pinnedNaturalW, pinnedNaturalH));

    document.body.classList.add('ytpp-active');
    vp.setAttribute('ytpp-pinned', '');
    startBlockingHidden(vp);
    attachScrubber(isLive);
    flashControls();
  }

  function unpin() {
    if (!pinnedCard) return;

    // Disarm page_shim.js before removing CSS classes so a mouseleave fired
    // by the element snapping back doesn't hit stale guard state.
    document.dispatchEvent(new CustomEvent('ytpp-unpin'));

    pinnedCard.removeAttribute('ytpp-pinned-card');
    document.body.classList.remove('ytpp-active');
    pinnedCard     = null;
    pinnedIsLive   = false;
    pinnedNaturalW = 0;
    pinnedNaturalH = 0;
    setPauseState(false);
    detachScrubber();
    stopBlockingHidden();

    // Use the element captured at pin time — if YouTube rebuilt the preview
    // while pinned, re-querying would leave ytpp-pinned stuck on the old one.
    clearTimeout(controlsFlashTimer);
    pinnedVP?.removeAttribute('ytpp-pinned');
    pinnedVP?.removeAttribute('ytpp-show-controls');
    pinnedVP = null;
    document.documentElement.style.removeProperty('--ytpp-scale');
  }

  // ---- Event listeners -----------------------------------------------------

  document.addEventListener('click', (e) => {
    if (e.button !== 0) return;

    if (e.target.closest?.('.ytpp-unpin-btn')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      unpin();
      return;
    }

    if (e.target.closest?.('.ytpp-pause-btn')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      togglePause();
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
        ytppGetSettings((settings) => {
          if (card === currentPreviewCard && document.contains(card) && isPreviewVisible()) {
            pin(card, settings.disableCaptionsOnPin);
          }
        });
      }
      return;
    }

    if (pinnedCard) {
      const vp = getPreviewEl();
      const inCard     = pinnedCard.contains(e.target);
      const inVp       = vp?.contains(e.target) ?? false;
      const inControls = controls.contains(e.target);
      if (!inCard && !inVp && !inControls) {
        // If the mousedown started inside the preview this click is the end
        // of a drag-off, not a real backdrop click — swallow it.
        const draggedOff = mousedownInsidePreview;
        mousedownInsidePreview = false;
        if (draggedOff) return;
        e.stopPropagation();
        e.preventDefault();
        unpin();
      }
    }
  }, true);

  // CSS pointer-events:none is the primary guard against hover events on
  // non-pinned cards; this is the JS belt-and-suspenders for anything that
  // slips through. Pointer events included — a mouse fires both, and some
  // of YouTube's experiment bundles listen for the pointer variants.
  for (const type of ['mouseenter', 'mouseover', 'pointerenter', 'pointerover']) {
    document.addEventListener(type, (e) => {
      if (!pinnedCard) return;
      const other = findCard(e.target);
      if (other && other !== pinnedCard) e.stopImmediatePropagation();
    }, true);
  }

  // Keyboard controls while pinned: Esc unpins, Space toggles pause,
  // ← / → seek 5 s. Space and the arrows are left alone when a form control
  // or editable element has focus — both to avoid stealing typing from the
  // search box and because our own buttons/scrubber already handle those
  // keys natively (handling them here too would double-fire).
  function isInteractiveTarget(el) {
    const tag = el?.tagName ?? '';
    return el?.isContentEditable ||
      tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON';
  }

  document.addEventListener('keydown', (e) => {
    if (!pinnedCard) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      unpin();
      return;
    }

    if (e.key === ' ') {
      // Range inputs ignore Space, so it's safe (and expected) to toggle
      // pause even while the scrubber still has focus from a recent drag.
      if (isInteractiveTarget(e.target) && e.target !== scrubber) return;
      e.preventDefault(); // also stops the page-scroll default
      togglePause();
      flashControls();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (isInteractiveTarget(e.target)) return;
      e.preventDefault();
      seekBy(e.key === 'ArrowRight' ? 5 : -5);
    }
  }, true);

  // Recompute scale on resize using the stored natural size — we never want
  // to remove ytpp-pinned, which would disturb YouTube's player state.
  window.addEventListener('resize', () => {
    if (!pinnedCard || !pinnedNaturalW) return;
    document.documentElement.style.setProperty('--ytpp-scale', computePinScale(pinnedNaturalW, pinnedNaturalH));
  }, { passive: true });

  // Fired by page_shim.js when a VOD seek lands at the end — 'ended' doesn't
  // fire for a paused video sitting at duration, so this is the signal.
  document.addEventListener('ytpp-vod-ended', () => {
    if (scrubbing) return;
    unpin();
  });

  document.addEventListener('yt-navigate-start', () => {
    unpin();
    document.body.classList.remove('ytpp-on-short');
    currentPreviewCard = null;
    lastSeenCard       = null;
  });

  document.addEventListener('yt-navigate-finish', () => {
    unpin();
    ensurePinButton();
    ensureControls();
  });

})();
