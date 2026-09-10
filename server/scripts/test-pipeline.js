/**
 * 검색 파이프라인 단독 테스트: node scripts/test-pipeline.js
 * Vision 없이, "화면에서 읽혔다고 가정한" 텍스트로 검색 품질을 확인한다.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicyChunks } from '../src/chunker.js';
import { Retriever } from '../src/retriever.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chunks = loadPolicyChunks(path.join(__dirname, '..', 'policies'));
const r = new Retriever();
await r.index(chunks);
console.log(`indexed ${chunks.length} chunks\n`);

const cases = [
  {
    label: '연차 신청 화면',
    query: '연차 종류 시작일 종료일 잔여 연차 승인자 신청하기 연차 신청 조건 차감 중복',
    expect: ['신청 조건', '차감', '승인선'],
  },
  {
    label: '질문: 2차 승인자가 반려하면?',
    query: '2차 승인자가 반려하면 어떻게 되나요 반려 처리 승인선',
    expect: ['반려'],
  },
  {
    label: '질문: 반차 시간 계산',
    query: '반차 반반차 시간 계산 오전 오후 근무 시간',
    expect: ['사용 단위', '휴가와 근태'],
  },
  {
    label: '질문: 승인 후 취소 가능?',
    query: '승인 완료 후 연차 취소 가능한가 취소 요청',
    expect: ['취소'],
  },
  {
    label: '동의어: 철회 가능한 휴무 신청',
    query: '휴무 신청을 철회할 수 있는 승인 단계',
    expect: ['취소'],
  },
  {
    label: '동의어: 직원 조직 트리',
    query: '직원 조직 트리 인원수 표시 기준',
    expect: ['인원수'],
  },
];

let pass = 0;
for (const c of cases) {
  const hits = await r.search(c.query, 5);
  const joined = hits.map((h) => h.citation).join(' | ');
  const ok = c.expect.some((e) => joined.includes(e));
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.label}`);
  hits.forEach((h, i) => console.log(`   ${i + 1}. [${h.score}] ${h.citation}`));
  console.log('');
}
console.log(`${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
