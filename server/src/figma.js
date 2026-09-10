const FIGMA_API = 'https://api.figma.com/v1';
const NODE_CACHE_TTL_MS = 10 * 60_000;
const nodeCache = new Map();
let rateLimitedUntil = 0;

export function getCachedFigmaNode({ fileKey, nodeId }) {
  const cacheKey = `${fileKey}:${nodeId}`;
  const cached = nodeCache.get(cacheKey);
  if (!cached?.value) return null;
  if (Date.now() - cached.createdAt >= NODE_CACHE_TTL_MS) {
    nodeCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

export async function fetchFigmaTextNodes({ fileKey, nodeId, token = process.env.FIGMA_TOKEN }) {
  if (!token) throw new Error('FIGMA_TOKEN 이 설정되지 않았습니다.');
  if (!fileKey || !nodeId) throw new Error('fileKey 와 nodeId 가 필요합니다.');

  if (Date.now() < rateLimitedUntil) {
    const seconds = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    const err = new Error(`figma 429: 요청 제한 해제까지 약 ${seconds}초 남았습니다.`);
    err.status = 429;
    throw err;
  }

  const cacheKey = `${fileKey}:${nodeId}`;
  const cachedValue = getCachedFigmaNode({ fileKey, nodeId });
  if (cachedValue) return cachedValue;
  const cached = nodeCache.get(cacheKey);
  if (cached?.promise) return cached.promise;

  const promise = loadFigmaTextNodes({ fileKey, nodeId, token });
  nodeCache.set(cacheKey, { promise });
  try {
    const value = await promise;
    nodeCache.set(cacheKey, { value, createdAt: Date.now() });
    return value;
  } catch (error) {
    nodeCache.delete(cacheKey);
    throw error;
  }
}

async function loadFigmaTextNodes({ fileKey, nodeId, token }) {
  const url = `${FIGMA_API}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`figma ${res.status}: ${body}`);
    err.status = res.status;
    if (res.status === 429) {
      const retryAfterSeconds = Number(res.headers.get('retry-after')) || 60;
      rateLimitedUntil = Date.now() + retryAfterSeconds * 1000;
    }
    throw err;
  }

  const json = await res.json();
  const root = json.nodes?.[nodeId]?.document;
  if (!root) throw new Error(`Figma node 를 찾지 못했습니다: ${nodeId}`);

  const textNodes = [];
  walk(root, (node) => {
    if (node.type !== 'TEXT') return;
    const characters = normalizeText(node.characters || '');
    if (!characters) return;
    textNodes.push({ id: node.id, name: node.name || 'TEXT', characters });
  });

  return {
    fileName: json.name || null,
    nodeName: root.name || null,
    nodeType: root.type || null,
    role: json.role || null,
    linkAccess: json.linkAccess || null,
    textNodes: dedupeTextNodes(textNodes),
  };
}

/**
 * 화면 텍스트를 검색 쿼리로 만든다.
 *
 * 반복 횟수를 일부러 남긴다. "내 근무" 캘린더에서 근무는 20번, 연차는 5번 나오지만
 * 좌측 전역 내비게이션의 예산/프로젝트/알림은 화면마다 1번씩만 나온다. 예전에는
 * unique() 가 이 빈도 차이를 지워버려서, 어느 화면을 넣어도 내비게이션 항목이
 * 본문과 같은 무게를 갖고 검색을 지배했다.
 */
const MAX_FRAGMENT_REPEATS = 5;
const MAX_QUERY_FRAGMENTS = 200;

export function buildFigmaSearchQuery({ pageContext = {}, textNodes = [] }) {
  const seeded = [
    pageContext.fileName,
    pageContext.documentTitle,
    ...textNodes.map((node) => node.characters),
  ]
    .map(normalizeText)
    .filter(isMeaningfulQueryText);

  const counts = new Map();
  const out = [];
  for (const fragment of seeded) {
    const seen = counts.get(fragment) || 0;
    if (seen >= MAX_FRAGMENT_REPEATS) continue; // 한 문구가 쿼리를 독점하지 않게 상한을 둔다
    counts.set(fragment, seen + 1);
    out.push(fragment);
    if (out.length >= MAX_QUERY_FRAGMENTS) break;
  }
  return out.join(' ');
}

/**
 * 도메인 판정 규칙. 단순 포함 여부가 아니라 "몇 개의 텍스트 노드에 나오는지" 로 센다.
 * 좌측 전역 내비게이션에는 구성원/휴가/결재/예산이 화면마다 한 번씩 들어 있어서,
 * 포함 여부만 보면 어떤 화면이든 맨 앞 규칙(구성원)으로 판정돼 버렸다.
 */
const DOMAIN_RULES = [
  { domain: '근태', keywords: ['근태', '근무', '출근', '퇴근', '출퇴근', '외근', '원격', '출장'] },
  { domain: '휴가', keywords: ['연차', '휴가', '반차', '휴무'] },
  { domain: '구성원', keywords: ['구성원', '조직도', '조직', '직원', '재직'] },
  { domain: '결재', keywords: ['결재', '승인', '반려', '승인선', '상신'] },
];

/** 프레임 이름이 화면명으로 쓸 만한지. "Frame 12" 같은 기본 이름은 걸러낸다. */
function isMeaningfulFrameName(name = '') {
  const trimmed = normalizeText(name);
  if (trimmed.length < 2) return false;
  return !/^(frame|group|rectangle|component|instance|slice|vector)\b/i.test(trimmed);
}

export function inferScreenFromFigma({ pageContext = {}, textNodes = [], hits = [] }) {
  const texts = textNodes.map((node) => node.characters);
  const has = (needle) => texts.some((text) => text.includes(needle));
  /** 해당 낱말을 포함한 텍스트 노드 수. 본문은 반복되고 내비게이션은 1회뿐이다. */
  const count = (needle) => texts.filter((text) => text.includes(needle)).length;
  const hit = hits[0];

  const ranked = DOMAIN_RULES.map((rule) => ({
    domain: rule.domain,
    score: rule.keywords.reduce((sum, keyword) => sum + count(keyword), 0),
  })).sort((a, b) => b.score - a.score);

  // 내비게이션 한 줄(1회)만으로는 도메인을 정하지 않는다. 근거가 약하면 검색 결과에 맡긴다.
  const winner = ranked[0]?.score >= 2 ? ranked[0] : null;
  let domain = winner?.domain || inferDomainFromHit(hit?.docTitle) || '업무';

  // 화면명은 선택한 프레임 이름이 가장 정확하다. 디자이너가 직접 붙인 이름이기 때문이다.
  // 쓸 만한 이름이 없을 때만 도메인/검색 결과로 추정한다.
  const frameName = [pageContext.nodeName, pageContext.fileName, pageContext.documentTitle].find(
    isMeaningfulFrameName
  );
  let screen = frameName || hit?.citation?.split(' > ')[0] || 'Figma 화면';

  if (!frameName && winner) {
    if (domain === '구성원') screen = has('조직도') ? '구성원 조직도' : has('리스트뷰') ? '구성원 목록' : '구성원 관리';
    else if (domain === '휴가') screen = has('신청') ? '휴가 신청' : '휴가 관리';
    else if (domain === '결재') screen = '결재 화면';
    else if (domain === '근태') screen = '근무 관리';
  }

  const actions = unique(
    ['검색', '초기화', '승인', '참조', '리스트뷰', '캔버스뷰', '조직도']
      .filter((keyword) => has(keyword))
      .map((keyword) => actionLabel(keyword))
  ).slice(0, 5);

  const readText = texts.filter(isMeaningfulReadText).slice(0, 12);
  const policyKeywords = unique([
    ...texts.filter(isMeaningfulKeywordText).slice(0, 12),
    ...tokenizeCitation(hit?.citation).slice(0, 6),
  ]).slice(0, 8);

  // hit.score 는 절대 관련도(0~1)다. 관련 정책을 하나도 못 찾았다면 화면 추정도
  // 근거가 없는 것이므로 낮게 잡는다. (예전엔 0.55 라서 무관한 화면도 60% 로 보였다.)
  const base = hit ? Math.min(0.96, 0.45 + hit.score * 0.45) : 0.3;
  const confidence = Number(Math.min(0.98, base + Math.min(0.12, textNodes.length * 0.003)).toFixed(2));

  return {
    screen,
    domain,
    confidence,
    readText,
    actions,
    entities: policyKeywords,
    policyKeywords,
    searchQuery: buildFigmaSearchQuery({ pageContext, textNodes }),
  };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function dedupeTextNodes(nodes) {
  const seen = new Set();
  return nodes.filter((node) => {
    const key = `${node.name}\u0000${node.characters}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isMeaningfulQueryText(text) {
  if (!text) return false;
  if (/^\{.+\}$/.test(text)) return false;
  if (/^\d+$/.test(text)) return false;
  return text.length >= 2;
}

function isMeaningfulReadText(text) {
  return isMeaningfulQueryText(text) && text.length <= 40;
}

function isMeaningfulKeywordText(text) {
  return isMeaningfulQueryText(text) && text.length <= 24;
}

function inferDomainFromHit(docTitle = '') {
  const title = String(docTitle || '');
  if (title.includes('구성원')) return '구성원';
  if (title.includes('휴가')) return '휴가';
  if (title.includes('근태')) return '근태';
  if (title.includes('승인') || title.includes('결재')) return '결재';
  return '';
}

function tokenizeCitation(citation = '') {
  return String(citation)
    .split(/\s*>\s*|\s+/)
    .map((part) => part.trim())
    .filter((part) => part && !/^\d+(\.\d+)*$/.test(part));
}

function actionLabel(keyword) {
  if (keyword === '검색') return '구성원 검색';
  if (keyword === '초기화') return '검색 초기화';
  if (keyword === '승인') return '승인 상태 확인';
  if (keyword === '참조') return '참조자 확인';
  if (keyword === '리스트뷰') return '리스트뷰 전환';
  if (keyword === '캔버스뷰') return '캔버스뷰 전환';
  if (keyword === '조직도') return '조직도 확인';
  return keyword;
}
