const $ = (selector) => document.querySelector(selector);
const state = { documents: [], selected: null, view: 'read', query: '', version: null, history: null, comparison: null };

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function inline(text) {
  return text.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdown(markdown) {
  const lines = escapeHtml(markdown).split(/\r?\n/);
  let html = '';
  let list = null;
  const closeList = () => { if (list) html += `</${list}>`; list = null; };
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^-\s+(.+)$/.exec(line);
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    if (heading) { closeList(); html += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`; continue; }
    if (bullet || numbered) {
      const nextList = bullet ? 'ul' : 'ol';
      if (list !== nextList) { closeList(); list = nextList; html += `<${list}>`; }
      html += `<li>${inline((bullet || numbered)[1])}</li>`;
      continue;
    }
    closeList();
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

function filteredDocuments() {
  const q = state.query.toLowerCase();
  return state.documents.filter((doc) => !q || `${doc.title} ${doc.excerpt}`.toLowerCase().includes(q));
}

function renderList() {
  const documents = filteredDocuments();
  $('#count').textContent = `${documents.length}개 정책`;
  $('#policy-list').innerHTML = documents.map((doc) => `
    <button class="policy-item ${doc.file === state.selected?.file ? 'selected' : ''}" data-file="${encodeURIComponent(doc.file)}">
      <span>${escapeHtml(doc.title)}</span><small>${escapeHtml(doc.excerpt)}</small>
    </button>`).join('') || '<p class="empty">일치하는 정책이 없습니다.</p>';
  document.querySelectorAll('.policy-item').forEach((button) => button.addEventListener('click', () => selectPolicy(decodeURIComponent(button.dataset.file))));
}

function renderReader() {
  const doc = state.selected;
  if (!doc) return;
  $('#title').textContent = doc.title;
  const versionText = state.version ? ` · ${state.version.shortCommit} 버전` : '';
  $('#meta').textContent = `${doc.file}${versionText} · ${new Date(doc.updatedAt).toLocaleDateString('ko-KR')} 수정`;
  if (state.view === 'compare') return renderComparison();
  if (state.view === 'history') return renderHistory();
  const content = state.version?.content || doc.content;
  $('#content').classList.toggle('source', state.view === 'source');
  $('#content').innerHTML = state.view === 'source' ? `<pre>${escapeHtml(content)}</pre>` : renderMarkdown(content);
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
}

async function selectPolicy(file) {
  const response = await fetch(`/api/policies/${encodeURIComponent(file)}`);
  if (!response.ok) return;
  state.selected = await response.json();
  state.version = null;
  state.history = null;
  state.comparison = null;
  state.view = 'read';
  history.replaceState(null, '', `#${encodeURIComponent(file)}`);
  renderList();
  renderReader();
}

async function showHistory() {
  state.view = 'history';
  $('#content').classList.remove('source');
  $('#content').innerHTML = '<p class="loading">변경 이력을 불러오는 중입니다.</p>';
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  const response = await fetch(`/api/policies/${encodeURIComponent(state.selected.file)}/history`);
  state.history = await response.json();
  renderHistory();
}

function renderHistory() {
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.view === 'history'));
  const history = state.history;
  if (!history?.available) {
    $('#content').innerHTML = `<div class="history-empty"><b>이력 저장소를 연결하면 변경 내역을 볼 수 있습니다.</b><span>${escapeHtml(history?.error || '')}</span></div>`;
    return;
  }
  $('#content').innerHTML = history.versions.length ? `<div class="history">${history.versions.map((version) => `
    <section class="history-item"><div class="history-dot"></div><div class="history-main">
      <b>${escapeHtml(version.message)}</b><span>${escapeHtml(version.author)} · ${new Date(version.date).toLocaleString('ko-KR')} · <code>${version.shortCommit}</code></span>
      <div class="history-actions"><button data-commit="${version.commit}" class="version-button">이 버전 원문</button>${version.previousCommit ? `<button data-older="${version.previousCommit}" data-newer="${version.commit}" class="compare-button">변경 비교</button>` : ''}</div>
    </div></section>`).join('')}</div>` : '<div class="history-empty">이 정책의 변경 이력이 없습니다.</div>';
  document.querySelectorAll('.version-button').forEach((button) => button.addEventListener('click', () => showVersion(button.dataset.commit)));
  document.querySelectorAll('.compare-button').forEach((button) => button.addEventListener('click', () => showComparison(button.dataset.older, button.dataset.newer)));
}

async function showVersion(commit) {
  const response = await fetch(`/api/policies/${encodeURIComponent(state.selected.file)}/versions/${commit}`);
  if (!response.ok) return;
  const version = await response.json();
  const metadata = state.history.versions.find((item) => item.commit === commit);
  state.version = { ...version, ...metadata };
  state.view = 'source';
  renderReader();
}

async function showComparison(older, newer) {
  state.view = 'compare';
  $('#content').classList.remove('source');
  $('#content').innerHTML = '<p class="loading">변경 내용을 비교하는 중입니다.</p>';
  const response = await fetch(`/api/policies/${encodeURIComponent(state.selected.file)}/compare/${older}/${newer}`);
  if (!response.ok) return;
  state.comparison = await response.json();
  renderComparison();
}

function renderComparison() {
  const comparison = state.comparison;
  if (!comparison) return;
  const diffLines = escapeHtml(comparison.diff).split('\n').map((line) => {
    const kind = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : 'diff-context';
    return `<span class="${kind}">${line || ' '}</span>`;
  }).join('');
  $('#content').innerHTML = `
    <div class="compare-head"><div><p class="eyebrow">POLICY CHANGE</p><h2>${comparison.older.slice(0, 7)} → ${comparison.newer.slice(0, 7)}</h2></div><button class="back-to-history">이력으로 돌아가기</button></div>
    <section class="compare-diff"><h3>문장 변경</h3><pre class="diff-code">${diffLines}</pre></section>
    <section class="compare-columns"><div><h3>변경 전</h3><pre>${escapeHtml(comparison.before)}</pre></div><div><h3>변경 후</h3><pre>${escapeHtml(comparison.after)}</pre></div></section>`;
  $('.back-to-history').addEventListener('click', showHistory);
}

$('#search').addEventListener('input', (event) => { state.query = event.target.value; renderList(); });
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.view === 'history') return showHistory();
  state.view = button.dataset.view;
  renderReader();
}));

(async () => {
  const response = await fetch('/api/policies');
  state.documents = await response.json();
  const requested = decodeURIComponent(location.hash.slice(1));
  await selectPolicy(state.documents.some((doc) => doc.file === requested) ? requested : state.documents[0]?.file);
})();
