# YouTube Preview Pin

A Chrome extension that pins YouTube hover previews so they keep playing without holding the mouse over them. The preview centers on screen, scales to fill the viewport, and unmutes audio automatically.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

## Usage

1. Hover a video thumbnail and wait for the preview to start playing
2. Click the **📌 Pin** button that appears on the preview
3. The preview centers on screen over a dark backdrop and keeps playing
4. To unpin: click the red **📌 Unpin** button, click the backdrop, or press **Escape**

## Tweaking

**Scale** — edit `computePinScale` in `content.js`. The two numbers control the size:
```js
const targetW = Math.min(window.innerWidth * 0.80, 1200);
```
`0.80` is the fraction of the viewport width to target; `1200` is the maximum width in pixels.

**Unpin keybinding** — edit the `keydown` handler at the bottom of `content.js`.

**Mute** — to keep the video muted, remove the audio block from the `ytpp-pin` handler in `page_shim.js`.

## How it works

YouTube's hover preview is a single shared `ytd-video-preview` element that gets positioned next to whichever card you're hovering and hidden the moment the mouse leaves. Keeping it alive requires intercepting several of YouTube's internal mechanisms.

### `page_shim.js` (page realm, `document_start`)

Runs in the page's own JavaScript realm before any YouTube script loads. This is the key to intercepting YouTube's handlers before they're registered:

- **`EventTarget.prototype.addEventListener` wrap** — every handler YouTube registers for `mouseleave`, `mouseout`, `blur`, and `resize` gets a guard that no-ops it while a preview is pinned. Because this runs at `document_start`, all of YouTube's handlers are wrapped before they're registered.
- **Attribute guards** — prototype-level overrides on `Element.prototype.setAttribute`, `toggleAttribute`, and the `hidden` IDL setter block YouTube from setting `hidden` on the preview element while pinned.
- **Pause protection** — patches `video.pause` on the preview's `<video>` element and adds a `pause` event listener that immediately calls `play()` while pinned.
- **Player control** — calls the YouTube player API to unmute audio and disable captions on pin.

### `content.js` (isolated content script, `document_idle`)

Manages the DOM and coordinates the pin state:

- Injects the **📌 Pin / Unpin** button into `ytd-video-preview`
- On pin: dispatches a synchronous `CustomEvent('ytpp-pin')` on `document` **before** adding the CSS class that moves the element — this ensures `page_shim.js` has its guards armed before the browser synthesises a `mouseleave` from the element shifting position
- Adds a full-screen **backdrop** that absorbs mouse events so YouTube's card hover handlers never fire while pinned
- Computes a responsive **scale factor** from the viewport width at pin time and updates it on window resize, stored as a CSS custom property (`--ytpp-scale`)
- Runs a **MutationObserver** as a secondary guard that reverts any `hidden`, `display:none`, `visibility:hidden`, or `opacity:0` set on the preview or its descendants

### `styles.css`

- Positions the pinned preview with `position:fixed` centered via `translate(-50%, -50%) scale(var(--ytpp-scale))`
- Sets `pointer-events:none` on `ytd-video-preview` itself (so the element can't be a `mouseleave` target) while keeping `pointer-events:auto` on all children
- Hides the pin button by default and fades it in via `:hover` / `:has(:hover)`

## License

MIT

## Known limitations

- Some preview clips don't include audio in their stream, so unmuting has no effect.
- If YouTube updates their DOM and cards stop being detected, update `CARD_SELECTORS` in `content.js`.
