# YouTube Preview Pin

Chrome extension that pins YouTube's hover preview so it keeps playing without you holding the mouse over the thumbnail. The preview centers on screen, scales up, unmutes, and switches to a quality that fits its new size (up to 1080p).

It's a useful filter for deciding whether a video is worth your time before committing to the watch page (and the ad that fires when you load it). This isn't an ad blocker, though. You should still support the creators of your favorite content, either directly through memberships and donations or by watching the ads on their videos.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick this folder

## Use

Hover a thumbnail, wait for the preview to start, then click **Pin** in the top-left of the preview. Unpin with the **✕** button in the top-right corner, by clicking the backdrop, or by pressing Escape.

While pinned:

| Key | Action |
| --- | --- |
| `Space` | Pause / play |
| `←` / `→` | Seek 5 seconds |
| `Esc` | Unpin |

Hover the preview to show the playback bar along its bottom edge: play / pause, the time, and a scrubber (VOD videos show elapsed / total time; live streams can scrub back through the DVR window).

Settings (right-click the toolbar icon → Options) has one toggle: whether to also turn off captions when pinning.

## Limitations

- **Quality tops out at 1080p.** Hover previews normally play at about 480p because the player sizes its stream for the thumbnail. Pinning asks for a quality that fits the enlarged preview, capped at 1080p, and hands control back to YouTube on unpin. Your saved YouTube quality preference is left untouched.
- It doesn't work on Shorts, or on the mobile site (`m.youtube.com`), which has no hover previews.
- If YouTube renames an internal class or custom element, the relevant selectors will need updating. They're collected in a `YT` object near the top of `content.js` and `page_shim.js`, plus the `ytdVideoPreview*` overrides in `styles.css`.

## License

MIT
