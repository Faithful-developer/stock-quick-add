// Service worker for Stock Quick Add.
importScripts('profiles.js');

// Two jobs only: make the toolbar icon open the side panel, and handle the
// keyboard shortcut. No network calls happen here — the panel owns those.

// Clicking the extension icon opens the side panel instead of a popup.
// setPanelBehavior is persistent, but the worker can be torn down and revived,
// so we set it on install and on browser startup.
function enablePanelOnActionClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('setPanelBehavior failed:', err));
}

chrome.runtime.onInstalled.addListener(enablePanelOnActionClick);
chrome.runtime.onStartup.addListener(enablePanelOnActionClick);

// Moves pre-profile installs onto the profile shape and repairs the endpoint
// older builds guessed at. See migrateLegacy() in profiles.js.
chrome.runtime.onInstalled.addListener(() => {
  migrateLegacy().catch((err) => console.error('migrateLegacy failed:', err));
});

// The open-panel command (Control+Shift+S on macOS, Alt+Shift+S elsewhere by
// default; rebindable at chrome://extensions/shortcuts) opens the panel.
// chrome.sidePanel.open() requires a user gesture; a command counts as one,
// so this must be awaited directly in the listener without any prior await.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'open-panel') return;

  if (tab && typeof tab.windowId === 'number') {
    chrome.sidePanel
      .open({ windowId: tab.windowId })
      .catch((err) => console.error('sidePanel.open failed:', err));
    return;
  }

  // Fallback: some contexts (e.g. a devtools-focused window) give no tab.
  chrome.windows.getCurrent({}, (win) => {
    if (!win) return;
    chrome.sidePanel
      .open({ windowId: win.id })
      .catch((err) => console.error('sidePanel.open failed:', err));
  });
});
