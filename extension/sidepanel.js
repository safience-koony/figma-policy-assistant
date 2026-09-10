const API = 'http://localhost:8787';

const $ = (s) => document.querySelector(s);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s = '') =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let state = { screen: null, sources: [], history: [] };
let pluginSelection = null;
let lastPluginSelectionKey = null;

/* ── 서버 상태 ────────────────────────────────────────────── */

(async function health() {
  const s = $('#status');
  try {
    const r = await fetch(`${API}/api/health`).then((r) => r.json());
    s.innerHTML = r.mock
      ? `<span class="dot dot--warn"></span>MOCK · 정책 ${r.chunks}개`
      : `<span class="dot"></span>${esc(r.provider || 'api')} · 정책 ${r.chunks}개`;
  } catch {
    s.innerHTML = '<span class="dot dot--off"></span>서버 연결 안 됨';
  }
})();

// Figma 플러그인이 전달한 선택 상태를 읽는다. URL의 node-id 갱신을 기다릴 필요가 없다.
async function syncPluginSelection() {
  try {
    const response = await fetch(`${API}/api/figma-selection`);
    const { selection } = await response.json();
    if (!selection?.fileKey || !selection?.nodeId) return;
    const key = `${selection.fileKey}:${selection.nodeId}:${selection.updatedAt}`;
    pluginSelection = selection;
    if (key === lastPluginSelectionKey) return;
    lastPluginSelectionKey = key;
    if (!$('#view-empty').hidden) renderPluginSelection(selection);
  } catch {
    // 플러그인을 사용하지 않거나 서버가 꺼져 있으면 기존 확장 흐름을 유지한다.
  }
}

function renderPluginSelection(selection) {
  document.querySelector('#view-empty .empty__t').textContent = '선택한 Figma 프레임';
  document.querySelector('#view-empty .empty__d').textContent = `${selection.nodeName} · ${selection.nodeType}`;
  $('#btn-analyze').textContent = '이 프레임 분석';
}

setInterval(syncPluginSelection, 1200);
syncPluginSelection();

/* ── 화면 전환 ────────────────────────────────────────────── */

function show(view) {
  for (const id of ['view-empty', 'view-loading', 'view-confirm', 'view-result', 'view-error']) {
    $('#' + id).hidden = id !== view;
  }
  $('#footer').hidden = view !== 'view-result';
}

function setStep(name, s) {
  const node = document.querySelector(`.step[data-step="${name}"]`);
  if (node) node.dataset.state = s;
}
function setStepLabel(name, label) {
  const node = document.querySelector(`.step[data-step="${name}"]`);
  if (node) node.childNodes[node.childNodes.length - 1].nodeValue = label;
}
function resetSteps() {
  document.querySelectorAll('.step').forEach((n) => (n.dataset.state = ''));
}

// 결과를 닫고 Figma에서 다른 프레임을 고를 시간을 준다.
function chooseAnotherFrame() {
  resetSteps();
  show('view-empty');
}

function fail(title, detail, action) {
  const box = $('#view-error');
  box.innerHTML = `<b>${esc(title)}</b>${esc(detail)}`;
  if (action) {
    const btn = el(`<button class="btn btn--primary err__act">${esc(action.label)}</button>`);
    btn.addEventListener('click', action.onClick);
    box.appendChild(btn);
  }
  show('view-error');
  $('#footer').hidden = !state.screen;
}

/** 서버가 돌려준 에러 문자열 → [제목, 설명]. 자주 나오는 원인은 사람이 읽을 문장으로 바꾼다. */
function serverError(msg = '') {
  if (/figma 429|rate limit exceeded/i.test(msg)) {
    return [
      'Figma API 요청이 잠시 제한되었습니다',
      '짧은 시간에 같은 프레임을 여러 번 읽어 발생할 수 있습니다. 잠시 후 다시 시도해주세요.',
    ];
  }
  if (/credit balance is too low/i.test(msg)) {
    return [
      'Anthropic 크레딧이 부족합니다',
      'console.anthropic.com → Plans & Billing 에서 크레딧을 충전해주세요. ' +
        'claude.ai 구독은 API 크레딧과 별개입니다.\n' +
        '충전 전까지는 .env 의 ANTHROPIC_API_KEY 를 비우고 서버를 재시작하면 MOCK 모드로 확인할 수 있습니다.',
    ];
  }
  if (/authentication_error|invalid x-api-key/i.test(msg)) {
    return ['API 키가 올바르지 않습니다', '.env 의 ANTHROPIC_API_KEY 를 확인한 뒤 서버를 재시작해주세요.'];
  }
  if (/rate_limit|overloaded/i.test(msg)) {
    return ['Anthropic API 가 혼잡합니다', '잠시 후 다시 시도해주세요.\n' + msg];
  }
  return ['분석에 실패했습니다', msg];
}

/* ── 캡처 권한 ────────────────────────────────────────────── */

// chrome.permissions.request 는 사용자 제스처 안에서만 동작한다.
// await 를 거치면 제스처가 소멸하므로 클릭 핸들러의 첫 줄에서 호출해야 한다.
async function grantCaptureAndRetry() {
  let granted;
  try {
    granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
  } catch (e) {
    return fail('권한을 요청하지 못했습니다', String(e.message || e));
  }
  if (!granted) {
    return fail(
      '권한이 허용되지 않았습니다',
      '화면을 캡처할 수 없으면 분석을 시작할 수 없습니다.',
      { label: '다시 요청', onClick: grantCaptureAndRetry }
    );
  }
  analyze();
}

/* ── 분석 실행 ────────────────────────────────────────────── */

$('#btn-analyze').addEventListener('click', analyze);

async function analyze() {
  if (pluginSelection) {
    const context = await chrome.runtime.sendMessage({ type: 'FIGMA_CONTEXT' });
    if (!context?.pageContext?.fileKey) {
      return fail('Figma 파일을 찾지 못했습니다', '분석할 Figma 탭을 활성화한 뒤 다시 시도해주세요.');
    }
    return confirmFigmaTarget({
      mode: 'figma',
      pageContext: {
        ...context.pageContext,
        ...pluginSelection,
        fileName: context.pageContext.fileName || pluginSelection.documentName,
        documentTitle: context.pageContext.documentTitle || pluginSelection.documentName,
      },
    });
  }

  const cap = await chrome.runtime.sendMessage({ type: 'CAPTURE' });
  if (!cap?.ok) {
    if (cap?.code === 'NEED_CAPTURE_PERMISSION') {
      return fail('화면 캡처 권한이 필요합니다', cap.error, {
        label: '권한 허용',
        onClick: grantCaptureAndRetry,
      });
    }
    return fail('화면을 캡처하지 못했습니다', cap?.error || '탭 권한을 확인해주세요.');
  }

  if (cap.mode === 'figma') return confirmFigmaTarget(cap);
  return runAnalysis(cap);
}

async function confirmFigmaTarget(cap) {
  let target, res;
  try {
    res = await fetch(`${API}/api/figma-target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileKey: cap.pageContext.fileKey, nodeId: cap.pageContext.nodeId }),
    });
    target = await res.json();
  } catch (e) {
    return fail('Figma 프레임을 확인하지 못했습니다', `${e.message}\n서버가 ${API} 에서 실행 중인지 확인해주세요.`);
  }
  if (!res.ok) return fail(...serverError(target?.error || res.statusText));

  const box = $('#view-confirm');
  box.innerHTML = `
    <div class="screen__label">선택한 Figma ${esc(target.type === 'FRAME' ? '프레임' : '요소')}</div>
    <div class="screen__name">${esc(target.name || cap.pageContext.nodeName || `node ${cap.pageContext.nodeId}`)}</div>
    <div class="hint" style="text-align:left;margin:8px 0 16px">이 ${esc(target.type === 'FRAME' ? '프레임' : '요소')}에 대해 분석할까요?</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn--primary" id="btn-confirm-analyze">분석하기</button>
      <button class="btn btn--ghost" id="btn-confirm-cancel">다시 선택</button>
    </div>`;
  $('#btn-confirm-analyze').addEventListener('click', () => runAnalysis(cap));
  $('#btn-confirm-cancel').addEventListener('click', chooseAnotherFrame);
  show('view-confirm');
}

async function runAnalysis(cap) {
  resetSteps();
  show('view-loading');
  setStep('capture', 'active');
  setStepLabel('capture', cap.mode === 'figma' ? 'Figma 프레임 읽기' : '화면 캡처');
  setStep('capture', 'done');
  setStep('vision', 'active');

  let data, res;
  try {
    res = await fetch(`${API}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screenshot: cap.screenshot, pageContext: cap.pageContext }),
    });
    data = await res.json();
  } catch (e) {
    // fetch 자체가 던졌으면 서버에 닿지 못한 것 (연결 거부 / JSON 아닌 응답)
    return fail('분석 서버에 연결하지 못했습니다', `${e.message}\n서버가 ${API} 에서 실행 중인지 확인해주세요.`);
  }
  // 여기까지 왔으면 서버는 살아 있다. 실패는 서버 안쪽 문제이므로 원인을 그대로 보여준다.
  if (!res.ok) return fail(...serverError(data?.error || res.statusText));
  setStep('vision', 'done');
  setStep('search', 'done');
  setStep('summary', 'done');

  state = { screen: data.screen, sources: data.sources, history: [] };
  render(data, cap.pageContext);
  show('view-result');
}

/* ── 렌더 ─────────────────────────────────────────────────── */

function srcBadge(id) {
  const s = state.sources.find((x) => x.id === id);
  if (!s) return '';
  return `<a class="src" data-src="${esc(id)}" title="${esc(s.excerpt || '')}">
    <span class="src__ic">📄</span>${esc(s.citation)}</a>`;
}

function render(data, pageContext) {
  const sc = data.screen;

  $('#screen-card').innerHTML = `
    <div class="screen__row">
      <div style="flex:1">
        <div class="screen__label">현재 화면</div>
        <div class="screen__name">${esc(sc.screen)}</div>
        <div class="chips">
          <span class="chip chip--accent">${esc(sc.domain)}</span>
          ${(sc.actions || []).slice(0, 4).map((a) => `<span class="chip">${esc(a)}</span>`).join('')}
        </div>
      </div>
      <button class="btn btn--ghost" id="btn-re">새 프레임 선택</button>
    </div>
    <div class="conf">
      <div class="conf__txt"><span>판단 신뢰도</span><span>${Math.round((sc.confidence ?? 0) * 100)}%</span></div>
      <div class="conf__bar"><div class="conf__fill" style="width:${Math.round((sc.confidence ?? 0) * 100)}%"></div></div>
    </div>
    <div class="hint" style="text-align:left;margin-top:9px">
      ${esc(pageContext?.fileName || pageContext?.documentTitle || 'Figma')}${
        pageContext?.nodeId ? ` · node ${esc(pageContext.nodeId)}` : ''
      } · ${esc(data.analysisMode === 'figma_text' ? `Figma text${data.figma?.textCount ? ` ${data.figma.textCount}` : ''}` : 'Vision')} · ${
        data.mock ? 'MOCK' : `${data.tookMs}ms`
      }
    </div>`;
  $('#btn-re').addEventListener('click', chooseAnotherFrame);

  const pol = data.summary.policies || [];
  $('#policies').innerHTML =
    `<div class="sec-title">관련 정책 <span class="sec-title__count">${pol.length}</span></div>` +
    (data.matched === false
      ? `<div class="open-q"><span>⚠</span><span>${esc(
          data.notice || '정책 문서에서 이 화면과 관련된 내용을 찾지 못했습니다.'
        )}</span></div>`
      : '') +
    pol
      .map(
        (p, i) => `
    <details class="card policy" ${i === 0 ? 'open' : ''}>
      <summary class="policy__hd">
        <span class="policy__idx">${i + 1}</span>
        <span style="flex:1">
          <span class="policy__t">${esc(p.title)}</span>
          <div class="policy__s">${esc(p.summary)}</div>
          <div>${(p.sourceIds || []).map(srcBadge).join('')}</div>
        </span>
        <span class="policy__caret">▾</span>
      </summary>
      <div class="policy__body">${esc(
        state.sources.find((s) => s.id === (p.sourceIds || [])[0])?.excerpt || '원문을 불러오려면 출처를 클릭하세요.'
      )}</div>
    </details>`
      )
      .join('');

  const notes = data.summary.devNotes || [];
  $('#notes').innerHTML = notes.length
    ? `<div class="sec-title">개발 시 체크리스트 <span class="sec-title__count">${notes.length}</span></div>
       <div class="card notes">${notes
         .map(
           (n, i) => `<div class="note">
             <span class="note__ic">${i + 1}</span>
             <span><div class="note__t">${esc(n.note)}</div>
             <div>${(n.sourceIds || []).map(srcBadge).join('')}</div></span>
           </div>`
         )
         .join('')}</div>`
    : '';

  const oq = data.summary.openQuestions || [];
  $('#open-questions').innerHTML = oq.length
    ? `<div class="open-q"><span>⚠</span><span>${oq.map(esc).join('<br>')}</span></div>`
    : '';

  $('#chat').innerHTML = '';
  $('#suggests').innerHTML = [
    '이 화면에서 백엔드가 체크해야 할 정책 뭐야?',
    'QA 테스트 케이스로 정리해줘',
    '예외 상황은 뭐가 있어?',
  ]
    .map((q) => `<button class="suggest">${esc(q)}</button>`)
    .join('');
}

/* ── 출처 클릭 → 원문 ─────────────────────────────────────── */

document.addEventListener('click', async (e) => {
  const badge = e.target.closest('.src');
  if (badge) {
    const id = badge.dataset.src;
    const c = await fetch(`${API}/api/policy/${encodeURIComponent(id)}`).then((r) => r.json());
    const body = badge.closest('details')?.querySelector('.policy__body');
    if (body) body.textContent = c.text || '';
    else alert(`${c.citation}\n\n${c.text}`);
  }
  const sug = e.target.closest('.suggest');
  if (sug) {
    $('#q').value = sug.textContent;
    sendQuestion();
  }
});

/* ── 질문 ─────────────────────────────────────────────────── */

const q = $('#q');
q.addEventListener('input', () => {
  $('#send').disabled = !q.value.trim();
  q.style.height = 'auto';
  q.style.height = Math.min(q.scrollHeight, 96) + 'px';
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendQuestion();
  }
});
$('#send').addEventListener('click', sendQuestion);

async function sendQuestion() {
  const text = q.value.trim();
  if (!text) return;
  q.value = '';
  q.style.height = 'auto';
  $('#send').disabled = true;

  const chat = $('#chat');
  chat.appendChild(el(`<div class="msg msg--me"><div class="msg__b">${esc(text)}</div></div>`));
  const pending = el('<div class="msg msg--ai"><div class="msg__b">…</div></div>');
  chat.appendChild(pending);
  chat.scrollIntoView({ block: 'end', behavior: 'smooth' });

  try {
    const res = await fetch(`${API}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: text, screen: state.screen, history: state.history }),
    });
    const r = await res.json();
    // 200 이 아니면 r.answer 가 없다. 그대로 렌더하면 "undefined" 가 찍힌다.
    if (!res.ok) throw new Error(serverError(r?.error || res.statusText).join(' — '));

    for (const s of r.sources || []) {
      if (!state.sources.some((x) => x.id === s.id)) state.sources.push(s);
    }
    pending.innerHTML = `<div class="msg__b">${esc(r.answer)}</div>
      <div class="msg__src">${(r.sources || []).slice(0, 3).map((s) => srcBadge(s.id)).join('')}</div>`;
    state.history.push({ role: 'user', content: text }, { role: 'assistant', content: r.answer });
  } catch (e) {
    pending.innerHTML = `<div class="msg__b">답변을 가져오지 못했습니다: ${esc(e.message)}</div>`;
  }
  chat.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

show('view-empty');
