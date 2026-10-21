// YTPP_DEFAULTS and ytppGetSettings come from settings.js.
const toggle = document.getElementById('disableCaptions');

ytppGetSettings((settings) => {
  toggle.checked = settings.disableCaptionsOnPin;
});

toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ disableCaptionsOnPin: toggle.checked }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[ytpp] storage write failed:', chrome.runtime.lastError);
    }
  });
});
