const toggle = document.getElementById('disableCaptions');

chrome.storage.sync.get({ disableCaptionsOnPin: true }, ({ disableCaptionsOnPin }) => {
  toggle.checked = disableCaptionsOnPin;
});

toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ disableCaptionsOnPin: toggle.checked });
});
