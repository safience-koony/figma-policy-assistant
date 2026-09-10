/**
 * LLM 호출 래퍼. 프로바이더 4종을 LLM_PROVIDER 로 고른다.
 *
 *   api    ANTHROPIC_API_KEY 로 Messages API 직접 호출. 가장 빠르고 안정적. API 크레딧 필요.
 *   codex  로그인된 codex CLI 를 서브프로세스로 호출. ChatGPT 구독으로 커버되며 API 키가 필요 없다.
 *   claude 로그인된 claude CLI 를 서브프로세스로 호출. Claude 구독으로 커버된다.
 *   mock   키도 CLI 도 없이 전체 흐름만 시연.
 *
 * 지정이 없으면 키가 있으면 api, 없으면 mock. CLI 모드는 로그인된 그 머신에서만 동작하므로
 * 서버를 배포할 계획이라면 api 로 돌아와야 한다.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

export const PROVIDER = (
  process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'api' : 'mock')
).toLowerCase();
export const MOCK = PROVIDER === 'mock';

const CLI_MODEL = process.env.LLM_CLI_MODEL || '';
const CLI_TIMEOUT_MS = Number(process.env.LLM_CLI_TIMEOUT_MS || 180_000);
// codex 기본값(medium)은 이 작업에 과하다. low 로 낮추면 품질 차이 없이 ~20% 빠르다.
// (minimal 은 tools 와 함께 쓸 수 없어 400 이 난다.)
const CLI_EFFORT = process.env.LLM_CLI_EFFORT || 'low';

/** 프로바이더 공통 인터페이스: 프롬프트(+선택적 이미지) → 텍스트 */
async function complete({ system, prompt, imageBase64, mediaType = 'image/png', maxTokens = 2000 }) {
  if (PROVIDER === 'api') return callApi({ system, prompt, imageBase64, mediaType, maxTokens });
  if (PROVIDER === 'codex' || PROVIDER === 'claude') {
    return callCli({ system, prompt, imageBase64, mediaType });
  }
  throw new Error(`알 수 없는 LLM_PROVIDER: ${PROVIDER}`);
}

async function callApi({ system, prompt, imageBase64, mediaType, maxTokens }) {
  const content = [];
  if (imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } });
  }
  content.push({ type: 'text', text: prompt });

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

/**
 * CLI 프로바이더. 두 CLI 모두 system 프롬프트를 따로 받지 않으므로 프롬프트 앞에 붙인다.
 * 프롬프트는 정책 발췌문 때문에 길어질 수 있어 argv 대신 stdin 으로 넘긴다.
 */
async function callCli({ system, prompt, imageBase64, mediaType }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'figma-policy-'));
  try {
    let imagePath = null;
    if (imageBase64) {
      imagePath = path.join(dir, mediaType.includes('jpeg') ? 'screen.jpg' : 'screen.png');
      await writeFile(imagePath, Buffer.from(imageBase64, 'base64'));
    }
    let full = `${system}\n\n---\n\n${prompt}`;

    if (PROVIDER === 'codex') {
      const outFile = path.join(dir, 'out.txt');
      const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '-o', outFile];
      if (CLI_EFFORT) args.push('-c', `model_reasoning_effort="${CLI_EFFORT}"`);
      if (CLI_MODEL) args.push('-m', CLI_MODEL);
      if (imagePath) args.push('-i', imagePath);
      args.push('-'); // 프롬프트는 stdin
      await run('codex', args, full, dir);
      return (await readFile(outFile, 'utf8')).trim();
    }

    // claude CLI 는 이미지 첨부 플래그가 없다. 파일 경로를 주고 Read 도구로 열게 한다.
    if (imagePath) {
      full += `\n\n분석할 스크린샷: ${imagePath}\n먼저 Read 도구로 이 이미지를 연 뒤 답해라.`;
    }
    const args = ['-p', '--output-format', 'json', '--allowedTools', 'Read', '--add-dir', dir];
    if (CLI_MODEL) args.push('--model', CLI_MODEL);
    const raw = await run('claude', args, full, dir);
    const json = JSON.parse(raw);
    if (json.is_error) throw new Error(`claude CLI: ${json.result || json.subtype}`);
    return String(json.result ?? '').trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cmd, args, stdin, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: process.env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${cmd} 응답이 ${CLI_TIMEOUT_MS}ms 를 넘겨 중단했습니다.`));
    }, CLI_TIMEOUT_MS);

    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) =>
      reject(new Error(`${cmd} 를 실행하지 못했습니다: ${e.message} — 설치와 로그인 상태를 확인해주세요.`))
    );
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${cmd} exit ${code}: ${(err || out).slice(0, 500)}`));
      resolve(out);
    });
    p.stdin.end(stdin ?? '');
  });
}

/** CLI 에이전트는 JSON 앞뒤에 설명이나 코드펜스를 붙일 때가 있어 단계적으로 벗겨낸다. */
function parseJson(text) {
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 아래로 */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* 아래로 */
    }
  }
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM 응답에서 JSON 을 찾지 못했습니다: ' + trimmed.slice(0, 200));
  return JSON.parse(m[0]);
}

/* ── 1단계: 화면 의미 추출 (Vision) ────────────────────────────── */

const VISION_SYSTEM = `너는 사내 업무 시스템의 화면을 분석하는 도우미다.
주어진 것은 Figma 캔버스 스크린샷이다. 화면에 보이는 텍스트, 입력 필드, 버튼, 레이아웃을 근거로
이 화면이 어떤 업무 화면인지 추론하고 아래 JSON 스키마로만 답한다. 설명 문장은 쓰지 않는다.

{
  "screen": "화면명 추정 (예: 연차 신청 상세)",
  "domain": "업무 도메인 (예: 휴가)",
  "confidence": 0.0~1.0,
  "readText": ["화면에서 읽은 주요 텍스트"],
  "actions": ["이 화면에서 사용자가 수행하는 행위"],
  "entities": ["화면에 등장하는 업무 개념/데이터"],
  "policyKeywords": ["정책 문서를 검색할 때 쓸 키워드 4~8개"],
  "searchQuery": "정책 검색용 한 줄 쿼리"
}
근거가 약하면 confidence 를 낮추고, 보이지 않는 내용을 지어내지 않는다.`;

export async function analyzeScreen({ imageBase64, mediaType = 'image/png', pageContext }) {
  if (MOCK) return mockAnalysis();
  const text = await complete({
    system: VISION_SYSTEM,
    prompt: `이 화면을 분석해줘.\n참고용 페이지 문맥(신뢰도 낮음): ${JSON.stringify(pageContext || {})}`,
    imageBase64,
    mediaType,
    maxTokens: 1200,
  });
  return parseJson(text);
}

/* ── 2단계: 검색된 정책 요약 + 개발 주의사항 ──────────────────── */

const SUMMARY_SYSTEM = `너는 기획/개발자를 돕는 사내 정책 어시스턴트다.
반드시 <policies> 안에 주어진 발췌문에만 근거해 답한다. 발췌문에 없는 내용은 절대 추측하지 않는다.
모든 항목에는 근거가 된 발췌문의 id 를 sourceIds 로 남긴다.

아래 JSON 스키마로만 답한다.
{
  "screenSummary": "이 화면이 하는 일 1~2문장",
  "policies": [
    { "title": "정책 제목", "summary": "2~3문장 요약", "sourceIds": ["파일명#n"] }
  ],
  "devNotes": [
    { "note": "개발 시 검증/주의사항 한 줄", "sourceIds": ["파일명#n"] }
  ],
  "openQuestions": ["정책 문서만으로 판단이 안 되는 항목"]
}`;

export async function summarizePolicies({ screen, chunks }) {
  if (MOCK) return mockSummary(chunks);
  const text = await complete({
    system: SUMMARY_SYSTEM,
    prompt: `<screen>${JSON.stringify(screen)}</screen>\n\n<policies>\n${renderChunks(
      chunks
    )}\n</policies>\n\n이 화면을 개발/기획할 때 알아야 할 정책과 주의사항을 정리해줘.`,
    maxTokens: 2000,
  });
  return parseJson(text);
}

/* ── 3단계: 후속 질문 (챗봇) ──────────────────────────────────── */

const ASK_SYSTEM = `너는 사내 정책 어시스턴트다. <policies> 발췌문에만 근거해 한국어로 간결히 답한다.
근거가 없으면 "제공된 정책 문서에서는 확인되지 않습니다" 라고 말하고 추측하지 않는다.
답변 마지막에 반드시 다음 형식의 출처 줄을 붙인다.
출처: [파일명#n] 섹션 경로`;

export async function ask({ question, screen, chunks, history = [] }) {
  if (MOCK) return mockAnswer(question, chunks);
  // CLI 프로바이더에는 messages 배열이 없으므로 직전 대화를 프롬프트 안에 접어 넣는다.
  const prior = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? '질문' : '답변'}: ${m.content}`)
    .join('\n');
  return complete({
    system: ASK_SYSTEM,
    prompt:
      (prior ? `<history>\n${prior}\n</history>\n\n` : '') +
      `<screen>${JSON.stringify(screen)}</screen>\n\n<policies>\n${renderChunks(
        chunks
      )}\n</policies>\n\n질문: ${question}`,
    maxTokens: 1500,
  });
}

function renderChunks(chunks) {
  return chunks
    .map((c) => `[${c.id}] ${c.citation}\n${c.text}`)
    .join('\n\n---\n\n');
}

/* ── MOCK 응답 (API 키 없이 데모/테스트용) ────────────────────── */

function mockAnalysis() {
  return {
    screen: '연차 신청',
    domain: '휴가',
    confidence: 0.86,
    readText: ['연차 종류', '시작일', '종료일', '잔여 연차 12일', '승인자', '신청하기'],
    actions: ['연차 신청', '연차 유형 선택', '기간 선택', '승인자 지정'],
    entities: ['연차', '잔여 연차', '반차', '승인자', '신청 기간'],
    policyKeywords: ['연차 신청 조건', '잔여 연차 차감', '승인 프로세스', '연차 중복 신청', '반차 계산'],
    searchQuery: '연차 신청 잔여 연차 차감 반차 승인자 기간 중복 검증',
    _mock: true,
  };
}

function mockSummary(chunks) {
  return {
    screenSummary:
      '연차 유형과 기간을 선택하고 승인자를 지정해 연차를 신청하는 화면입니다. (MOCK 응답)',
    policies: chunks.slice(0, 3).map((c) => ({
      title: c.citation.split(' > ').slice(-1)[0],
      summary: c.text.replace(/\n+/g, ' ').slice(0, 140) + '…',
      sourceIds: [c.id],
    })),
    devNotes: chunks.slice(0, 3).map((c) => ({
      note: `${c.citation.split(' > ').slice(-1)[0]} 조건을 서버에서 검증해야 합니다.`,
      sourceIds: [c.id],
    })),
    openQuestions: ['ANTHROPIC_API_KEY 를 설정하면 실제 LLM 요약으로 대체됩니다.'],
    _mock: true,
  };
}

function mockAnswer(question, chunks) {
  const top = chunks[0];
  return `(MOCK) "${question}" 에 대해 가장 관련 있는 정책은 다음과 같습니다.\n\n${
    top ? top.text.split('\n').slice(0, 3).join('\n') : '검색 결과가 없습니다.'
  }\n\n출처: [${top?.id ?? '-'}] ${top?.citation ?? '-'}`;
}
