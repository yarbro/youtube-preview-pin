// Settings shared by content.js and the options page. Loaded ahead of both
// (manifest.json, options.html), so these are globals in their scope.

const YTPP_DEFAULTS = { disableCaptionsOnPin: true };

// chrome.storage.sync.get throws synchronously once the extension context
// is invalidated (extension reloaded/updated while a tab stays open). Fall
// back to the defaults in every failure mode so callers always get settings.
function ytppGetSettings(cb) {
  try {
    chrome.storage.sync.get(YTPP_DEFAULTS, (settings) => {
      cb(chrome.runtime.lastError ? YTPP_DEFAULTS : settings);
    });
  } catch (_) {
    cb(YTPP_DEFAULTS);
  }
}
