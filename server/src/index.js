import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadPolicyChunks } from './chunker.js';
import { buildFigmaSearchQuery, fetchFigmaTextNodes, getCachedFigmaNode, inferScreenFromFigma } from './figma.js';
import { Retriever, createEmbedder } from './retriever.js';
import { analyzeScreen, summarizePolicies, ask, MOCK, PROVIDER } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = process.env.POLICY_DIR || path.join(__dirname, '..', 'policies');
const POLICY_REPO_DIR = process.env.POLICY_REPO_DIR || '';
const PORT = process.env.PORT || 8787;
const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // 스크린샷 dataURL
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * 검색이 관련 정책을 하나도 찾지 못했을 때의 응답.
 * 이 경우 summarizePolicies 를 호출하지 않는다. 근거 없는 발췌문을 쥐여주면
 * LLM 이 화면에 맞춰 정책서에 없는 문장을 만들어내기 때문이다.
 */
const NO_POLICY_NOTICE =
  '이 화면과 관련된 정책을 정책 문서에서 찾지 못했습니다. 근거 없는 요약을 만들지 않기 위해 분석을 생략했습니다.';

const emptySummary = () => ({ screenSummary: '', policies: [], devNotes: [], openQuestions: [] });

const retriever = new Retriever({ embedder: createEmbedder() });
let chunks = [];
let policyDocuments = [];
let latestFigmaSelection = null;
/** 스크린샷 해시 → 분석 결과. 정책을 재색인하면 비운다. */
const analyzeCache = new Map();

async function buildIndex() {
  chunks = loadPolicyChunks(POLICY_DIR);
  policyDocuments = loadPolicyDocuments(POLICY_DIR);
  await retriever.index(chunks);
  analyzeCache.clear(); // 정책이 바뀌면 이전 요약은 더 이상 유효하지 않다

  console.log(`[index] ${chunks.length} chunks from ${POLICY_DIR}`);
}

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    mock: MOCK,
    provider: PROVIDER,
    chunks: chunks.length,
    embedder: !!process.env.VOYAGE_API_KEY,
  })
);

app.post('/api/reindex', async (_req, res) => {
  await buildIndex();
  res.json({ ok: true, chunks: chunks.length });
});

/** Figma 플러그인이 선택 변경마다 전달하는 현재 프레임 정보. */
app.post('/api/figma-selection', (req, res) => {
  const { fileKey, nodeId, nodeName, nodeType, documentName, selectionCount, updatedAt } = req.body || {};
  if (!nodeId || !nodeName) return res.status(400).json({ error: 'nodeId, nodeName 이 필요합니다.' });
  latestFigmaSelection = { fileKey, nodeId, nodeName, nodeType, documentName, selectionCount, updatedAt: updatedAt || new Date().toISOString() };
  res.json({ ok: true });
});

app.get('/api/figma-selection', (req, res) => {
  const fileKey = req.query.fileKey;
  if (fileKey && latestFigmaSelection?.fileKey !== fileKey) return res.json({ selection: null });
  res.json({ selection: latestFigmaSelection });
});

/** Figma 플러그인이 읽은 선택 프레임 텍스트만으로 정책을 분석한다. */
app.post('/api/analyze-text', async (req, res) => {
  try {
    const { pageContext = {}, textNodes = [], topK = 5 } = req.body || {};
    const nodes = textNodes
      .slice(0, 200)
      .map((node) => ({ id: String(node.id || ''), name: String(node.name || 'TEXT'), characters: String(node.characters || '').trim() }))
      .filter((node) => node.characters);
    if (!nodes.length) return res.status(400).json({ error: '선택 프레임에서 텍스트를 찾지 못했습니다.' });

    const t0 = Date.now();
    const query = buildFigmaSearchQuery({ pageContext, textNodes: nodes });
    const hits = await retriever.search(query, topK);
    const screen = inferScreenFromFigma({ pageContext, textNodes: nodes, hits });
    const matched = hits.length > 0;
    const summary = matched ? await summarizePolicies({ screen, chunks: hits }) : emptySummary();
    res.json({
      screen,
      query,
      summary,
      matched,
      notice: matched ? null : NO_POLICY_NOTICE,
      analysisMode: 'plugin_text',
      sources: hits.map(({ id, citation, file, line, score, text }) => ({ id, citation, file, line, score, excerpt: text.slice(0, 400) })),
      tookMs: Date.now() - t0,
      mock: MOCK,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** 웹 정책 라이브러리용 Markdown 문서 목록과 원문. */
app.get('/api/policies', (_req, res) => {
  res.json(
    policyDocuments.map(({ content, ...document }) => document)
  );
});

app.get('/api/policies/:file', (req, res) => {
  const document = policyDocuments.find((item) => item.file === req.params.file);
  if (!document) return res.status(404).json({ error: 'policy not found' });
  res.json(document);
});

app.get('/api/policies/:file/history', async (req, res) => {
  const document = policyDocuments.find((item) => item.file === req.params.file);
  if (!document) return res.status(404).json({ error: 'policy not found' });
  try {
    res.json(await getPolicyHistory(document.file));
  } catch (e) {
    console.error(e);
    res.json({ available: false, error: '정책 이력을 불러오지 못했습니다.', versions: [] });
  }
});

app.get('/api/policies/:file/versions/:commit', async (req, res) => {
  const document = policyDocuments.find((item) => item.file === req.params.file);
  if (!document) return res.status(404).json({ error: 'policy not found' });
  if (!/^[0-9a-f]{7,64}$/i.test(req.params.commit)) return res.status(400).json({ error: 'invalid commit' });
  try {
    const { stdout } = await runGit(['show', `${req.params.commit}:policies/${document.file}`]);
    res.json({ commit: req.params.commit, content: stdout });
  } catch (e) {
    console.error(e);
    res.status(404).json({ error: '해당 버전의 정책을 찾지 못했습니다.' });
  }
});

app.get('/api/policies/:file/compare/:older/:newer', async (req, res) => {
  const document = policyDocuments.find((item) => item.file === req.params.file);
  if (!document) return res.status(404).json({ error: 'policy not found' });
  if (![req.params.older, req.params.newer].every((commit) => /^[0-9a-f]{7,64}$/i.test(commit))) {
    return res.status(400).json({ error: 'invalid commit' });
  }
  try {
    const filePath = `policies/${document.file}`;
    const [before, after, diff] = await Promise.all([
      runGit(['show', `${req.params.older}:${filePath}`]),
      runGit(['show', `${req.params.newer}:${filePath}`]),
      runGit(['diff', '--no-color', '--unified=1', req.params.older, req.params.newer, '--', filePath]),
    ]);
    res.json({ older: req.params.older, newer: req.params.newer, before: before.stdout, after: after.stdout, diff: diff.stdout });
  } catch (e) {
    console.error(e);
    res.status(404).json({ error: '비교할 정책 버전을 찾지 못했습니다.' });
  }
});

/** 확인 화면은 캐시된 이름만 읽는다. 이 단계에서는 Figma API를 호출하지 않는다. */
app.post('/api/figma-target', async (req, res) => {
  try {
    const { fileKey, nodeId } = req.body || {};
    const figma = getCachedFigmaNode({ fileKey, nodeId: normalizeNodeId(nodeId) });
    res.json({ ok: true, name: figma?.nodeName || null, type: figma?.nodeType || 'FRAME' });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: String(e.message || e) });
  }
});

/** 화면 분석 → 정책 검색 → 요약. Extension 의 [현재 화면 분석] 버튼이 호출한다. */
app.post('/api/analyze', async (req, res) => {
  try {
    const { screenshot, pageContext, topK = 5 } = req.body || {};
    const hasFigmaTarget = Boolean(pageContext?.fileKey && pageContext?.nodeId);
    if (!screenshot && !hasFigmaTarget) {
      return res.status(400).json({ error: 'screenshot 또는 Figma frame 정보가 필요합니다.' });
    }

    const m = /^data:(image\/\w+);base64,(.+)$/s.exec(screenshot);
    const mediaType = m ? m[1] : 'image/png';
    const imageBase64 = m ? m[2] : screenshot;

    // 같은 화면을 다시 분석하면 LLM 을 두 번 더 부르지 않는다. [다시] 버튼과
    // 스크롤 없이 반복 확인하는 흐름에서 20초 넘는 대기가 통째로 사라진다.
    // Figma node는 같은 ID라도 편집될 수 있으므로 캡처 분석만 캐시한다.
    const key = imageBase64 ? createHash('sha1').update(imageBase64).digest('hex') : null;
    const cached = key ? analyzeCache.get(key) : null;
    if (cached) return res.json({ ...cached, cached: true, tookMs: 0 });

    const t0 = Date.now();
    let screen;
    let query = '';
    let hits = [];
    let analysisMode = 'vision';
    let figma = null;

    if (pageContext?.fileKey && pageContext?.nodeId && process.env.FIGMA_TOKEN) {
      try {
        figma = await fetchFigmaTextNodes({
          fileKey: pageContext.fileKey,
          nodeId: normalizeNodeId(pageContext.nodeId),
        });
        query = buildFigmaSearchQuery({ pageContext: { ...pageContext, fileName: figma.fileName }, textNodes: figma.textNodes });
        hits = await retriever.search(query, topK);
        if (figma.textNodes.length >= 5 && hits.length) {
          screen = inferScreenFromFigma({
            pageContext: { ...pageContext, fileName: figma.fileName },
            textNodes: figma.textNodes,
            hits,
          });
          analysisMode = 'figma_text';
        }
      } catch (e) {
        figma = { error: String(e.message || e), status: e.status || null, textNodes: [] };
        console.warn('[figma]', figma.error);
      }
    }

    if (!screen && !imageBase64) {
      const reason = figma?.error || 'Figma 프레임의 텍스트를 읽지 못했습니다.';
      throw new Error(`Figma 프레임 분석을 완료하지 못했습니다: ${reason}`);
    }

    if (!screen) {
      screen = await analyzeScreen({ imageBase64, mediaType, pageContext });
      query = [screen.searchQuery, ...(screen.policyKeywords || [])].join(' ');
      hits = await retriever.search(query, topK);
    }

    const matched = hits.length > 0;
    const summary = matched ? await summarizePolicies({ screen, chunks: hits }) : emptySummary();

    const payload = {
      screen,
      query,
      analysisMode,
      matched,
      notice: matched ? null : NO_POLICY_NOTICE,
      sources: hits.map(({ id, citation, file, line, score, text }) => ({
        id, citation, file, line, score, excerpt: text.slice(0, 400),
      })),
      summary,
      tookMs: Date.now() - t0,
      mock: MOCK,
      figma: figma
        ? {
            fileName: figma.fileName || null,
            role: figma.role || null,
            linkAccess: figma.linkAccess || null,
            textCount: figma.textNodes?.length || 0,
            error: figma.error || null,
            status: figma.status || null,
          }
        : null,
    };

    if (key) {
      analyzeCache.set(key, payload);
      // 최근 20건만 유지 (스크린샷 base64 는 넣지 않으므로 메모리 부담은 작다)
      if (analyzeCache.size > 20) analyzeCache.delete(analyzeCache.keys().next().value);
    }

    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: String(e.message || e) });
  }
});

function normalizeNodeId(nodeId = '') {
  return String(nodeId).replace(/-/g, ':');
}

function loadPolicyDocuments(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, 'ko'))
    .map((file) => {
      const fullPath = path.join(dir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || file.replace(/\.md$/, '');
      const excerpt = content
        .split(/\r?\n/)
        .find((line) => line.trim() && !line.startsWith('#'))
        ?.trim() || '';
      return { file, title, excerpt, updatedAt: fs.statSync(fullPath).mtime.toISOString(), content };
    });
}

async function getPolicyHistory(file) {
  if (!POLICY_REPO_DIR) return { available: false, error: '정책 Git 저장소가 연결되지 않았습니다.', versions: [] };
  const format = '%H%x1f%an%x1f%aI%x1f%s';
  const { stdout } = await runGit(['log', '--follow', `--format=${format}`, '--', `policies/${file}`]);
  const versions = stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [commit, author, date, message] = line.split('\x1f');
    return { commit, shortCommit: commit.slice(0, 7), author, date, message };
  });
  return { available: true, versions: versions.map((version, index) => ({
    ...version,
    previousCommit: versions[index + 1]?.commit || null,
  })) };
}

async function runGit(args) {
  if (!POLICY_REPO_DIR) throw new Error('POLICY_REPO_DIR is not configured');
  return execFileAsync('git', ['-C', POLICY_REPO_DIR, ...args], { maxBuffer: 1024 * 1024 });
}

/** 후속 질문. 화면 컨텍스트를 함께 넘겨 검색 품질을 높인다. */
app.post('/api/ask', async (req, res) => {
  try {
    const { question, screen, history = [], topK = 5 } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question 이 필요합니다.' });

    const query = [question, screen?.searchQuery, ...(screen?.policyKeywords || [])]
      .filter(Boolean)
      .join(' ');
    const hits = await retriever.search(query, topK);
    // 근거가 없으면 LLM 에 묻지 않고 그대로 답한다. 빈 <policies> 를 주면
    // "확인되지 않습니다" 대신 일반 상식으로 답해버리는 경우가 있다.
    if (!hits.length) {
      return res.json({ answer: '제공된 정책 문서에서는 확인되지 않습니다.', sources: [], matched: false, mock: MOCK });
    }
    const answer = await ask({ question, screen, chunks: hits, history });

    res.json({
      answer,
      matched: true,
      sources: hits.map(({ id, citation, file, line, score }) => ({ id, citation, file, line, score })),
      mock: MOCK,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** 정책 원문 보기 */
app.get('/api/policy/:id', (req, res) => {
  const chunk = chunks.find((c) => c.id === req.params.id);
  if (!chunk) return res.status(404).json({ error: 'not found' });
  res.json(chunk);
});

await buildIndex();
app.listen(PORT, () =>
  console.log(`[server] http://localhost:${PORT}  (provider=${PROVIDER})`)
);
