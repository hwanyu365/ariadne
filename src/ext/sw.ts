chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// 패널마다 붙인 탭을 기억했다가, 패널이 닫혀 연결이 끊기면 뗀다 → 디버깅 배너와 탭 조작이 남지 않는다.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'panel') return;
  const tabs = new Set<number>();
  port.onMessage.addListener((m: { tabId: number; attached: boolean }) => {
    if (m.attached) tabs.add(m.tabId);
    else tabs.delete(m.tabId);
  });
  port.onDisconnect.addListener(() => {
    for (const tabId of tabs) chrome.debugger.detach({ tabId }).catch(() => {});
  });
});
