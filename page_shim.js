// Runs in world:"MAIN" at document_start (manifest.json). Communicates with
// content.js via synchronous CustomEvents on document. Wraps a handful of
// event-target and WebIDL APIs before any YouTube script runs so YouTube
// can't tear the inline player down while pinned.
(function () {
  'use strict';

  const YT = {
    PREVIEW:           'ytd-video-preview',
    PREVIEW_VIDEO:     'ytd-video-preview video',
    PLAYER:            'ytd-player',
    CC_BUTTON:         'ytd-video-preview .ytmClosedCaptioningButtonButton',
    CC_BUTTON_PRESSED: 'ytd-video-preview button[aria-pressed]',
  };

  let pinned           = false;
  let pinnedIsLive     = false;
  let lockedVP         = null;
  let guardedVideo     = null;
  let userPaused       = false;
  let pausedForScrub   = false;
  let seekInProgress   = false;
  let pauseGuardFn     = null;
  let seekingFn        = null;
  let seekedFn         = null;
  let userInteractedAt    = 0; // performance.now() of the last user input inside the preview
  let captionObserver     = null;
  let userToggledCaptions = false; // sticky: once the user touches CC, stop auto-disabling

  // ---- EventTarget / ResizeObserver wrap -----------------------------------

  const _OrigResizeObserver = window.ResizeObserver;
  if (_OrigResizeObserver) {
    window.ResizeObserver = class extends _OrigResizeObserver {
      constructor(callback) {
        super((entries, observer) => { if (!pinned) callback(entries, observer); });
      }
    };
  }

  const _origAEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, handler, options) {
    if (typeof handler !== 'function') {
      return _origAEL.call(this, type, handler, options);
    }
    const self = this;

    // window blur/resize: YouTube uses these to tear the player down. Our own
    // resize listener is in the isolated world and uses a different prototype.
    if (type === 'blur' || type === 'resize') {
      return _origAEL.call(this, type, function (e) {
        if (pinned && self === window) return;
        return handler.call(this, e);
      }, options);
    }

    // mouseleave/mouseout inside the locked preview triggers Polymer's
    // synchronous player teardown. node.contains(node) is true for self.
    if (type === 'mouseleave' || type === 'mouseout') {
      return _origAEL.call(this, type, function (e) {
        if (pinned && lockedVP?.contains(e.target)) return;
        return handler.call(this, e);
      }, options);
    }

    // LIVE only: blocking 'waiting' stops YouTube from snapping back to the
    // last buffered position on every unbuffered DVR scrub. VOD videos need
    // 'waiting' so MediaSource.endOfStream() can run and fire 'ended'.
    if (type === 'waiting') {
      return _origAEL.call(this, type, function (e) {
        if (pinned && pinnedIsLive && lockedVP?.contains(e.target)) return;
        return handler.call(this, e);
      }, options);
    }

    return _origAEL.call(this, type, handler, options);
  };

  // ---- Attribute / WebIDL guards -------------------------------------------

  const _origSetAttribute = Element.prototype.setAttribute;
  const _origToggleAttr   = Element.prototype.toggleAttribute;
  const _hiddenDesc       = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');
  const _mutedDesc        = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');

  Element.prototype.setAttribute = function (name, value) {
    if (this === lockedVP && pinned && name === 'hidden') return;
    return _origSetAttribute.call(this, name, value);
  };

  Element.prototype.toggleAttribute = function (name, force) {
    if (this === lockedVP && pinned && name === 'hidden' && force !== false) return false;
    return _origToggleAttr.call(this, name, force);
  };

  // element.hidden = true goes through WebIDL, bypassing setAttribute.
  if (_hiddenDesc?.set && _hiddenDesc.configurable) {
    Object.defineProperty(HTMLElement.prototype, 'hidden', {
      configurable: true,
      enumerable:   _hiddenDesc.enumerable,
      get:          _hiddenDesc.get,
      set(v) {
        if (this === lockedVP && pinned && v) return;
        _hiddenDesc.set.call(this, v);
      },
    });
  }

  // video.muted = true also goes through WebIDL. Block YouTube's automatic
  // re-mutes on the video we've unmuted, but let user-initiated mutes through
  // by gating on a recent input event (covers the native mute button and the
  // 'm' keyboard shortcut). Other videos on the page (ads, etc.) are
  // unaffected.
  const USER_MUTE_WINDOW_MS = 300;
  if (_mutedDesc?.set && _mutedDesc.configurable) {
    Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
      configurable: true,
      enumerable:   _mutedDesc.enumerable,
      get:          _mutedDesc.get,
      set(v) {
        if (pinned && v && this === guardedVideo &&
            performance.now() - userInteractedAt > USER_MUTE_WINDOW_MS) return;
        _mutedDesc.set.call(this, v);
      },
    });
  }

  // Stamp userInteractedAt on input events inside the preview so the muted
  // setter above can tell user-driven mutes from YouTube's automatic ones.
  // YouTube's keyboard shortcuts ('m', 'c') work document-wide, so keydown
  // is tracked regardless of focus.
  document.addEventListener('mousedown', (e) => {
    if (pinned && lockedVP?.contains(e.target)) userInteractedAt = performance.now();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!pinned) return;
    userInteractedAt = performance.now();
    if (e.key === 'c' || e.key === 'C') userToggledCaptions = true;
  }, true);

  // Clicks on the native CC button update aria-pressed asynchronously (the
  // caption module is sometimes loaded on demand), often well past the
  // muted-guard window — so use a sticky flag for captions instead.
  document.addEventListener('click', (e) => {
    if (!pinned || !lockedVP?.contains(e.target)) return;
    const btn = e.target.closest?.('button');
    if (btn && /caption|subtitle/i.test(btn.getAttribute('aria-label') ?? '')) {
      userToggledCaptions = true;
    }
  }, true);

  // ---- Helpers -------------------------------------------------------------

  function getVideo() {
    return document.querySelector(YT.PREVIEW_VIDEO);
  }

  function getPlayer() {
    const vp = document.querySelector(YT.PREVIEW);
    if (!vp) return null;
    const yp = vp.querySelector(YT.PLAYER);
    if (yp && typeof yp.getPlayer === 'function') {
      const p = yp.getPlayer(); if (p) return p;
    }
    if (typeof vp.getPlayer === 'function') {
      const p = vp.getPlayer(); if (p) return p;
    }
    return vp.playerApi ?? null;
  }

  function findCaptionButton() {
    return document.querySelector(YT.CC_BUTTON) ??
      [...document.querySelectorAll(YT.CC_BUTTON_PRESSED)]
        .find(b => /caption|subtitle/i.test(b.getAttribute('aria-label') ?? ''));
  }

  function disableCaptions() {
    // Prefer the native CC button so its aria-pressed stays in sync with
    // the actual captions state. Using only the player API leaves the
    // button stuck on "pressed", and combining both makes the second call
    // toggle captions back on.
    const btn = findCaptionButton();
    if (btn) {
      if (btn.getAttribute('aria-pressed') === 'true') btn.click();
      return;
    }
    // No CC button (some music videos): fall back to the player API.
    try {
      const player = getPlayer();
      if (player) {
        player.unloadModule?.('captions');
        player.setOption?.('captions', 'track', {});
      }
    } catch (_) {}
  }

  // Some videos auto-enable captions after pin time (music videos in
  // particular). Watch the pinned preview and re-disable on later auto-
  // activations, but step aside once the user has touched the CC control.
  function startCaptionGuard() {
    stopCaptionGuard();
    if (!lockedVP) return;
    userToggledCaptions = false;
    disableCaptions();
    captionObserver = new MutationObserver((mutations) => {
      if (userToggledCaptions) return;
      for (const mut of mutations) {
        const el = mut.target;
        if (mut.attributeName === 'aria-pressed' &&
            el.getAttribute?.('aria-pressed') === 'true' &&
            /caption|subtitle/i.test(el.getAttribute?.('aria-label') ?? '')) {
          try { disableCaptions(); } catch (_) {}
          return;
        }
      }
    });
    captionObserver.observe(lockedVP, {
      attributes:      true,
      attributeFilter: ['aria-pressed'],
      subtree:         true,
    });
  }

  function stopCaptionGuard() {
    captionObserver?.disconnect();
    captionObserver = null;
  }

  function unmute() {
    const player = getPlayer();
    if (player) {
      player.unMute?.();
      const vol = player.getVolume?.() ?? 0;
      if (vol < 5) player.setVolume?.(50);
      return;
    }
    const video = getVideo();
    if (video) {
      video.muted = false;
      if (video.volume < 0.1) video.volume = 0.5;
    }
  }

  function mute() {
    const player = getPlayer();
    if (player?.mute) { player.mute(); return; }
    const video = getVideo();
    if (video) video.muted = true;
  }

  // ---- Pause / seek guards -------------------------------------------------

  function patchPause(video) {
    if (video._ytppPatched) return;
    video._ytppPatched = true;
    video.pause = function () {
      if (pinned && !userPaused && !seekInProgress) return Promise.resolve();
      return HTMLMediaElement.prototype.pause.call(this);
    };
  }

  function unpatchPause(video) {
    if (!video?._ytppPatched) return;
    delete video.pause;
    delete video._ytppPatched;
  }

  function attachPauseGuard(video) {
    detachPauseGuard();
    guardedVideo = video;

    pauseGuardFn = () => {
      if (!pinned || userPaused || pausedForScrub || video.ended) return;
      // VOD seek-to-end fires 'pause' before YouTube destroys the player —
      // 'seeked' often never arrives, so use 'pause' as the unpin signal.
      if (!pinnedIsLive && isFinite(video.duration) && video.currentTime >= video.duration - 0.1) {
        document.dispatchEvent(new CustomEvent('ytpp-vod-ended'));
        return;
      }
      if (seekInProgress) return;
      video.play().catch(() => {});
    };

    seekingFn = () => { seekInProgress = true; };

    seekedFn = () => {
      seekInProgress = false;
      if (pinned && !pinnedIsLive && isFinite(video.duration) && video.currentTime >= video.duration - 0.1) {
        document.dispatchEvent(new CustomEvent('ytpp-vod-ended'));
        return;
      }
      // Skip auto-resume while pausedForScrub so the drag-pause persists
      // across the seeks fired by every scrubber 'input' event.
      if (pinned && !userPaused && !pausedForScrub && video.paused && !video.ended) {
        video.play().catch(() => {});
      }
    };

    video.addEventListener('pause', pauseGuardFn);
    // _origAEL: our own listeners must bypass the wrap above.
    _origAEL.call(video, 'seeking', seekingFn);
    _origAEL.call(video, 'seeked',  seekedFn);
  }

  function detachPauseGuard() {
    if (guardedVideo) {
      if (pauseGuardFn) guardedVideo.removeEventListener('pause',   pauseGuardFn);
      if (seekingFn)    guardedVideo.removeEventListener('seeking', seekingFn);
      if (seekedFn)     guardedVideo.removeEventListener('seeked',  seekedFn);
    }
    guardedVideo   = null;
    pauseGuardFn   = null;
    seekingFn      = null;
    seekedFn       = null;
    seekInProgress = false;
  }

  // ---- Recovery ------------------------------------------------------------
  // Window blur (alt-tab, etc.) — re-show the preview if YouTube hid it and
  // resume playback if it got paused. Registered with _origAEL so it bypasses
  // the wrapper that suppresses window-blur while pinned.

  _origAEL.call(window, 'blur', () => {
    if (!pinned || !lockedVP) return;
    Promise.resolve().then(() => {
      if (!pinned || !lockedVP) return;
      if (lockedVP.hasAttribute('hidden')) Element.prototype.removeAttribute.call(lockedVP, 'hidden');
      const video = getVideo();
      if (video?.paused && !video.ended && !userPaused && !pausedForScrub && !seekInProgress) {
        video.play().catch(() => {});
      }
    });
  });

  // ---- CustomEvent handlers ------------------------------------------------
  // Dispatched synchronously from content.js so state is set before any CSS
  // change that moves ytd-video-preview.

  document.addEventListener('ytpp-pin', (e) => {
    userPaused       = false;
    pausedForScrub   = false;
    userInteractedAt = 0;
    pinnedIsLive     = e.detail?.isLive === true;
    pinned           = true;
    lockedVP         = document.querySelector(YT.PREVIEW);

    try { unmute(); } catch (_) {}
    if (e.detail?.disableCaptions) try { startCaptionGuard(); } catch (_) {}
    try {
      const video = getVideo();
      if (video) { patchPause(video); attachPauseGuard(video); }
    } catch (_) {}
  });

  document.addEventListener('ytpp-unpin', () => {
    // Clear lockedVP before pinned=false so the prototype guards don't race
    // with any cleanup-time setAttribute.
    userPaused     = false;
    pausedForScrub = false;
    lockedVP       = null;
    pinned         = false;
    pinnedIsLive   = false;

    try {
      stopCaptionGuard();
      unpatchPause(getVideo());
      detachPauseGuard();
      mute();
    } catch (_) {}
  });

  document.addEventListener('ytpp-pause', () => {
    userPaused = true;
    try {
      const video = getVideo();
      if (video) HTMLMediaElement.prototype.pause.call(video);
    } catch (_) {}
  });

  document.addEventListener('ytpp-play', () => {
    userPaused = false;
    try {
      const video = getVideo();
      if (video) video.play().catch(() => {});
    } catch (_) {}
  });

  // Pause the video at the HTMLMediaElement level for the duration of a
  // scrub drag so natural playback can't carry currentTime into 'ended'
  // (which makes YouTube reload the source and the element disappear).
  // Prototype calls bypass our patched video.pause and YouTube's pause-
  // aware handlers, so resume on release is effectively instantaneous.
  document.addEventListener('ytpp-scrub-start', () => {
    try {
      const video = getVideo();
      if (video && pinned && !userPaused && !video.paused && !video.ended) {
        pausedForScrub = true;
        HTMLMediaElement.prototype.pause.call(video);
      }
    } catch (_) {}
  });

  document.addEventListener('ytpp-scrub-end', () => {
    if (!pausedForScrub) return;
    pausedForScrub = false;
    try {
      const video = getVideo();
      if (video && pinned && !userPaused && !video.ended) {
        HTMLMediaElement.prototype.play.call(video).catch(() => {});
      }
    } catch (_) {}
  });

})();
