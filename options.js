// Defaults must match content.js DEFAULTS.
const DEFAULTS = { disableCaptionsOnPin: true };

const toggle = document.getElementById('disableCaptions');

chrome.storage.sync.get(DEFAULTS, (settings) => {
  if (chrome.runtime.lastError) {
    console.warn('[ytpp] storage read failed:', chrome.runtime.lastError);
    toggle.checked = DEFAULTS.disableCaptionsOnPin;
    return;
  }
  toggle.checked = settings.disableCaptionsOnPin;
});

toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ disableCaptionsOnPin: toggle.checked }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[ytpp] storage write failed:', chrome.runtime.lastError);
    }
  });
});
