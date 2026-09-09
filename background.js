chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GV_OPEN_SIDEPANEL" && sender.tab?.id != null) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    );
    return true;
  }
  if (msg?.type === "GV_SOLD" && msg.query) {
    const params = new URLSearchParams({
      _nkw: msg.query,
      LH_Sold: "1",
      LH_Complete: "1",
      _sop: "13",
      _ipg: "25",
    });
    chrome.tabs.create({ url: `https://www.ebay.com/sch/i.html?${params.toString()}` });
    sendResponse({ ok: true });
  }
  return false;
});
