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
  };

  // Must match options.js.
  const DEFAULTS = { disableCaptionsOnPin: true };

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

  // ---- Utilities -----------------------------------------------------------

  const getPreviewEl     = () => document.querySelector(YT.PREVIEW);
  const isPreviewVisible = () => { const vp = getPreviewEl(); return vp && !vp.hasAttribute('hidden'); };
  const findCard         = (el) => el?.closest?.(YT.CARDS) ?? null;
  const isShortCard      = (card) => !!card.querySelector(YT.SHORT_CARD);

  // naturalW is offsetWidth before ytpp-pinned applies position:fixed.
  function computePinScale(naturalW) {
    const targetW = Math.min(window.innerWidth * 0.80, 1200);
    return Math.max(1.1, targetW / naturalW);
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const t = Math.floor(seconds);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // chrome.storage.sync.get throws synchronously once the extension context
  // is invalidated (extension reloaded/updated while this tab stays open).
  // Fall back to DEFAULTS in every failure mode so the pin still works.
  function getSettings(cb) {
    try {
      chrome.storage.sync.get(DEFAULTS, (settings) => {
        cb(chrome.runtime.lastError ? DEFAULTS : settings);
      });
    } catch (_) {
      cb(DEFAULTS);
    }
  }

  // ---- DOM setup -----------------------------------------------------------

  const backdrop = document.createElement('div');
  backdrop.id = 'ytpp-backdrop';
  document.body.appendChild(backdrop);

  const controls = document.createElement('div');
  controls.id = 'ytpp-controls';

  const controlsBtns = document.createElement('div');
  controlsBtns.className = 'ytpp-controls-btns';
  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'ytpp-pause-btn';
  pauseBtn.textContent = '⏸ Pause';
  controlsBtns.appendChild(pauseBtn);
  const unpinBtn = document.createElement('button');
  unpinBtn.className = 'ytpp-unpin-btn';
  unpinBtn.textContent = '📌 Unpin';
  controlsBtns.appendChild(unpinBtn);
  controls.appendChild(controlsBtns);

  const scrubberRow = document.createElement('div');
  scrubberRow.className = 'ytpp-scrubber-row';
  const scrubberLabel = document.createElement('span');
  scrubberLabel.className = 'ytpp-scrubber-label';
  scrubberLabel.textContent = '0:00';
  scrubberRow.appendChild(scrubberLabel);
  const scrubber = document.createElement('input');
  scrubber.type      = 'range';
  scrubber.className = 'ytpp-scrubber';
  scrubber.min       = '0';
  scrubber.max       = '1';
  scrubber.step      = '0.001';
  scrubber.value     = '0';
  scrubberRow.appendChild(scrubber);
  controls.appendChild(scrubberRow);

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
    scrubberLabel.textContent = formatTime(scrubVideo.currentTime);
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
    scrubberLabel.textContent = formatTime(video.currentTime);

    // 'seeking' fires with the target before timeupdate catches up, so this
    // keeps lastKnownTime current right up to the moment of teardown.
    seekingContentFn = () => { lastKnownTime = video.currentTime; };
    video.addEventListener('seeking', seekingContentFn);

    timeupdateFn = () => {
      lastKnownTime = scrubVideo.currentTime;
      if (isLive) syncRange();
      if (!scrubbing) {
        scrubber.value = String(scrubVideo.currentTime);
        scrubberLabel.textContent = formatTime(scrubVideo.currentTime);
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
    // for disconnection as a fallback.
    const aliveCheck = () => {
      if (!scrubVideo) { scrubAliveRafId = null; return; }
      if (!scrubbing && !scrubVideo.isConnected && lastKnownTime >= scrubEndThreshold - 0.5) {
        scrubAliveRafId = null;
        unpin();
        return;
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
    scrubberLabel.textContent = '0:00';
  }

  // ---- Pin / Unpin ---------------------------------------------------------

  function setPauseState(paused) {
    previewPaused = paused;
    pauseBtn.textContent = paused ? '▶ Play' : '⏸ Pause';
  }

  function pin(card, disableCaptions = true) {
    if (pinnedCard === card) return;
    if (pinnedCard) unpin();

    const vp = getPreviewEl();
    if (!vp) return;

    pinnedCard = card;
    pinnedVP   = vp;
    card.classList.add('ytpp-pinned-card');

    // YouTube reports a finite duration even for live previews, so detect
    // live from the LIVE badge on the card instead.
    const isLive = !!card.querySelector('.ytBadgeShapeThumbnailLive');
    pinnedIsLive = isLive;

    // Arm page_shim.js synchronously before the element moves.
    document.dispatchEvent(new CustomEvent('ytpp-pin', { detail: { disableCaptions, isLive } }));

    // Measure before ytpp-pinned applies position:fixed (which would change
    // the width).
    pinnedNaturalW = vp.offsetWidth || Math.round(window.innerWidth * 0.25);
    document.documentElement.style.setProperty('--ytpp-scale', computePinScale(pinnedNaturalW));

    document.body.classList.add('ytpp-active');
    vp.classList.add('ytpp-pinned');
    startBlockingHidden(vp);
    attachScrubber(isLive);
  }

  function unpin() {
    if (!pinnedCard) return;

    // Disarm page_shim.js before removing CSS classes so a mouseleave fired
    // by the element snapping back doesn't hit stale guard state.
    document.dispatchEvent(new CustomEvent('ytpp-unpin'));

    pinnedCard.classList.remove('ytpp-pinned-card');
    document.body.classList.remove('ytpp-active');
    pinnedCard     = null;
    pinnedIsLive   = false;
    pinnedNaturalW = 0;
    setPauseState(false);
    detachScrubber();
    stopBlockingHidden();

    // Use the element captured at pin time — if YouTube rebuilt the preview
    // while pinned, re-querying would leave ytpp-pinned stuck on the old one.
    pinnedVP?.classList.remove('ytpp-pinned');
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
      const pausing = !previewPaused;
      setPauseState(pausing);
      document.dispatchEvent(new CustomEvent(pausing ? 'ytpp-pause' : 'ytpp-play'));
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
        getSettings((settings) => {
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
  // slips through.
  for (const type of ['mouseenter', 'mouseover']) {
    document.addEventListener(type, (e) => {
      if (!pinnedCard) return;
      const other = findCard(e.target);
      if (other && other !== pinnedCard) e.stopImmediatePropagation();
    }, true);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pinnedCard) {
      e.preventDefault();
      unpin();
    }
  });

  // Recompute scale on resize using the stored natural width — we never want
  // to remove ytpp-pinned, which would disturb YouTube's player state.
  window.addEventListener('resize', () => {
    if (!pinnedCard || !pinnedNaturalW) return;
    document.documentElement.style.setProperty('--ytpp-scale', computePinScale(pinnedNaturalW));
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
