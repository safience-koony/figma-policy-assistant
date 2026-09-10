// 액션 클릭 → 사이드패널 열기
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// chrome://, chrome-extension://, 웹스토어 페이지는 확장이 캡처할 수 없다.
const CAPTURABLE = /^(https?|file|ftp):/i;

// captureVisibleTab 은 리터럴 <all_urls> 호스트 권한이나, 그 탭에 부여된 activeTab 을 요구한다.
// activeTab 은 툴바 아이콘을 누른 그 순간에만 부여되고 탭을 옮기면 사라지므로,
// 없으면 사이드패널이 사용자에게 <all_urls> 를 요청하도록 코드를 실어 돌려준다.
const hasCapturePermission = () => chrome.permissions.contains({ origins: ['<all_urls>'] });

function figmaContextFromUrl(rawUrl, title = '') {
  try {
    const url = new URL(rawUrl);
    const match = /\/(file|design|proto|board)\/([A-Za-z0-9]+)\/([^/?#]+)?/.exec(url.pathname);
    if (!match) return null;
    return {
      fileKey: match[2],
      fileName: match[3] ? decodeURIComponent(match[3]).replace(/-/g, ' ') : null,
      nodeId: url.searchParams.get('node-id'),
      pageId: url.searchParams.get('page-id'),
      documentTitle: title.replace(/ – Figma$/, ''),
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// 탭 전환·드래그 중이면 캡처가 일시적으로 거부된다 → 한 번 재시도.
async function captureWithRetry(windowId) {
  for (let i = 0; ; i++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      if (i >= 1) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'FIGMA_CONTEXT') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const context = tab ? figmaContextFromUrl(tab.url, tab.title) : null;
      sendResponse(context ? { ok: true, pageContext: { url: tab.url, title: tab.title, ...context } } : { ok: false });
    })().catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (msg?.type === 'CAPTURE') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) throw new Error('활성 탭을 찾을 수 없습니다.');
        if (!CAPTURABLE.test(tab.url || '')) {
          throw new Error(
            'Chrome 내부 페이지는 캡처할 수 없습니다. Figma 탭을 활성화한 뒤 다시 시도해주세요.'
          );
        }

        // Figma에서 선택한 프레임의 node-id를 먼저 읽는다. 있으면 캡처 없이
        // 서버가 Figma API의 텍스트 레이어를 직접 분석한다.
        let pageContext = { url: tab.url, title: tab.title, ...figmaContextFromUrl(tab.url, tab.title) };
        try {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.__figmaPolicyContext?.() ?? null,
          });
          if (res?.result) pageContext = { ...pageContext, ...res.result };
        } catch {
          /* content script 미주입 탭은 무시 */
        }

        if (pageContext.fileKey && pageContext.nodeId) {
          sendResponse({ ok: true, mode: 'figma', pageContext });
          return;
        }

        // 선택한 Figma 프레임이 없거나 다른 웹 페이지라면 기존 캡처 분석을 쓴다.
        let screenshot;
        try {
          screenshot = await captureWithRetry(tab.windowId);
        } catch (e) {
          if (await hasCapturePermission()) throw e;
          sendResponse({
            ok: false,
            code: 'NEED_CAPTURE_PERMISSION',
            error:
              '화면 캡처 권한이 없습니다. 툴바 아이콘을 눌러 패널을 열면 그 탭에서만 잠깐 허용되고, ' +
              '탭을 옮기면 사라집니다. 아래 버튼으로 항상 허용해주세요.',
          });
          return;
        }

        sendResponse({ ok: true, mode: 'screenshot', screenshot, pageContext });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true; // async
  }
});
