# YouTube Preview Pin

Chrome extension that pins YouTube's hover preview so it keeps playing without you holding the mouse over the thumbnail. The preview centers on screen, scales up, and unmutes.

It's a useful filter for deciding whether a video is worth your time before committing to the watch page (and the ad that fires when you load it). This isn't an ad blocker, though. You should still support the creators of your favorite content, either directly through memberships and donations or by watching the ads on their videos.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick this folder

## Use

Hover a thumbnail, wait for the preview to start, then click **📌 Pin** in the top-left of the preview. Unpin with the **📌 Unpin** button, by clicking the backdrop, or by pressing Escape.

Settings (right-click the toolbar icon → Options) has one toggle: whether to also turn off captions when pinning.

## Limitations

- **It's not full resolution.** YouTube serves the hover preview as its own lower-quality clip.
- It doesn't work on shorts
- If YouTube renames an internal class or custom element, the relevant selectors will need updating. They're collected in a `YT` object near the top of `content.js` and `page_shim.js`.

## License

MIT
