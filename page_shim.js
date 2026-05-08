/**
 * page_shim.js — runs in the PAGE's JS realm at document_start (world: "MAIN").
 *
 * Injected by Chrome via manifest.json. Communicates with content.js via
 * synchronous CustomEvents dispatched on document (ytpp-pin / ytpp-unpin).
 *
 * Responsibilities:
 *
 * 1. EVENT INTERCEPT — Wraps EventTarget.prototype.addEventListener before any
 *    YouTube script runs. While pinned, suppresses:
 *    - mouseleave / mouseout on ytd-video-preview or its descendants
 *    - blur and resize on window
 *    This prevents Polymer's synchronous player teardown on cursor movement,
 *    window focus loss, and window resize.
 *
 * 2. ATTRIBUTE GUARD — Prototype-level overrides block setAttribute('hidden'),
 *    toggleAttribute('hidden'), and the hidden IDL setter on the locked element,
 *    ensuring YouTube can't hide the preview element while pinned.
 *
 * 3. PLAYER CONTROL — Unmutes audio, simulates a CC button click to disable
 *    captions, and blocks video.pause while pinned.
 */
(function () {
  'use strict';

  let pinned          = false;
  let lockedVP        = null;  // ytd-video-preview element being protected
  let guardedVideo    = null;
  let pauseGuardFn    = null;

  // ---- 1. EventTarget.prototype.addEventListener intercept ----------------
  // Installed before any YouTube script runs (guaranteed by document_start).

  const _origAEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, handler, options) {
    if (typeof handler !== 'function') {
      return _origAEL.call(this, type, handler, options);
    }

    const self = this;

    // Suppress YouTube's window-level blur and resize handlers while pinned.
    // Our own resize listener lives in the isolated content-script world and
    // uses a separate EventTarget.prototype, so it is unaffected.
    if (type === 'blur' || type === 'resize') {
      return _origAEL.call(this, type, function ytppWindowWrap(e) {
        if (pinned && self === window) return;
        return handler.call(this, e);
      }, options);
    }

    // Suppress mouseleave / mouseout that target ytd-video-preview or any
    // of its descendants while pinned. node.contains(node) returns true for
    // the node itself, so this single check covers both cases.
    if (type === 'mouseleave' || type === 'mouseout') {
      return _origAEL.call(this, type, function ytppMouseWrap(e) {
        if (pinned && lockedVP?.contains(e.target)) return;
        return handler.call(this, e);
      }, options);
    }

    return _origAEL.call(this, type, handler, options);
  };

  // ---- 2. Attribute guard -------------------------------------------------

  const _origSetAttribute = Element.prototype.setAttribute;
  const _origToggleAttr   = Element.prototype.toggleAttribute;
  const _hiddenDesc       = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');

  Element.prototype.setAttribute = function (name, value) {
    if (this === lockedVP && pinned && name === 'hidden') return;
    return _origSetAttribute.call(this, name, value);
  };

  Element.prototype.toggleAttribute = function (name, force) {
    if (this === lockedVP && pinned && name === 'hidden' && force !== false) return false;
    return _origToggleAttr.call(this, name, force);
  };

  // element.hidden = true goes through C++ WebIDL, not through setAttribute.
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

  // ---- Helpers -------------------------------------------------------------

  function getVideo() {
    return document.querySelector('ytd-video-preview video');
  }

  function getPlayer() {
    const vp = document.querySelector('ytd-video-preview');
    if (!vp) return null;
    const yp = vp.querySelector('ytd-player');
    if (yp && typeof yp.getPlayer === 'function') {
      const p = yp.getPlayer(); if (p) return p;
    }
    if (typeof vp.getPlayer === 'function') {
      const p = vp.getPlayer(); if (p) return p;
    }
    return vp.playerApi ?? null;
  }

  // ---- Caption blocking ----------------------------------------------------

  function disableCaptions() {
    const btn =
      document.querySelector('ytd-video-preview .ytmClosedCaptioningButtonButton') ??
      [...document.querySelectorAll('ytd-video-preview button[aria-pressed]')]
        .find(b => /caption|subtitle/i.test(b.getAttribute('aria-label') ?? ''));
    if (btn?.getAttribute('aria-pressed') === 'true') btn.click();
  }

  // ---- Pause blocking ------------------------------------------------------

  function patchPause(video) {
    if (video._ytppPatched) return;
    video._ytppPatched = true;
    video.pause = function () {
      if (pinned) return Promise.resolve();
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
    pauseGuardFn = () => { if (pinned && !video.ended) video.play().catch(() => {}); };
    video.addEventListener('pause', pauseGuardFn);
  }

  function detachPauseGuard() {
    if (guardedVideo && pauseGuardFn) guardedVideo.removeEventListener('pause', pauseGuardFn);
    guardedVideo = null;
    pauseGuardFn = null;
  }

  // ---- Recovery blur handler -----------------------------------------------
  // Registered with _origAEL to bypass the wrapper that suppresses window-blur
  // while pinned — this is our own recovery path, not YouTube's teardown.

  _origAEL.call(window, 'blur', () => {
    if (!pinned || !lockedVP) return;
    Promise.resolve().then(() => {
      if (!pinned || !lockedVP) return;
      if (lockedVP.hasAttribute('hidden')) Element.prototype.removeAttribute.call(lockedVP, 'hidden');
      const video = getVideo();
      if (video?.paused && !video.ended) video.play().catch(() => {});
    });
  });

  // ---- 3. Pin / unpin handlers ---------------------------------------------
  // Dispatched synchronously by content.js, ensuring pinned/lockedVP are set
  // before the CSS class is applied and the element moves.

  document.addEventListener('ytpp-pin', (e) => {
    pinned   = true;
    lockedVP = document.querySelector('ytd-video-preview');

    // Audio: unmute and ensure audible volume.
    try {
      const player = getPlayer();
      if (player) {
        player.unMute?.();
        const vol = player.getVolume?.() ?? 0;
        if (vol < 5) player.setVolume?.(50);
      } else {
        const video = getVideo();
        if (video) {
          video.muted = false;
          if (video.volume < 0.1) video.volume = 0.5;
        }
      }
    } catch (_) {}

    // Captions: simulate the CC button click so YouTube records the preference.
    if (e.detail?.disableCaptions) try { disableCaptions(); } catch (_) {}

    // Pause protection: patch video.pause and add a 'pause' event guard.
    try {
      const video = getVideo();
      if (video) { patchPause(video); attachPauseGuard(video); }
    } catch (_) {}
  });

  document.addEventListener('ytpp-unpin', () => {
    // Clear lockedVP before pinned=false so prototype guards don't race with
    // any YouTube-initiated setAttribute call that fires during cleanup.
    lockedVP = null;
    pinned   = false;

    try {
      const video = getVideo();
      unpatchPause(video);
      detachPauseGuard();
      const player = getPlayer();
      if (player?.mute) player.mute();
      else if (video) video.muted = true;
    } catch (_) {}
  });

})();
