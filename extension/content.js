// Figma URL 에서 현재 선택한 프레임의 fileKey / nodeId / 페이지명을 뽑는다.
// 서버는 이 node-id로 Figma API의 텍스트 레이어를 직접 읽는다.
window.__figmaPolicyContext = () => {
  const url = new URL(location.href);
  const m = /\/(file|design|proto|board)\/([A-Za-z0-9]+)\/([^/?#]+)?/.exec(url.pathname);
  return {
    fileKey: m?.[2] ?? null,
    fileName: m?.[3] ? decodeURIComponent(m[3]).replace(/-/g, ' ') : null,
    nodeId: url.searchParams.get('node-id'),
    pageId: url.searchParams.get('page-id'),
    documentTitle: document.title.replace(/ – Figma$/, ''),
    capturedAt: new Date().toISOString(),
  };
};
