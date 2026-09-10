/**
 * 한국어 정책 문서용 경량 검색기.
 * - 기본: BM25 (외부 의존성 없음 → 키 없이도 바로 동작)
 * - 옵션: VOYAGE_API_KEY 가 있으면 임베딩 점수를 하이브리드로 합산
 *
 * 정책이 수천 건으로 늘어나면 이 모듈만 pgvector / Qdrant 등으로 교체하면 된다.
 * 인터페이스: index(chunks) / search(query, topK)
 */

const K1 = 1.5;
const B = 0.75;
const HYBRID_ALPHA = 0.5; // 임베딩 사용 시 BM25 : 임베딩 가중치
const METADATA_BOOST = 0.02;

/**
 * 절대 관련도 컷오프.
 *
 * BM25 원점수는 쿼리가 길수록 커지므로 그대로는 임계값을 걸 수 없고,
 * 최댓값으로 나누는 상대 정규화를 하면 top-1 이 항상 1.0 이 되어
 * "관련 없음" 을 아예 표현할 수 없다. 그래서 쿼리에서 신호가 가장 강한
 * IDF_BUDGET_TOKENS 개 토큰의 idf 합으로 나눈다. 분모에 상한이 잡히므로
 * 화면 텍스트가 60조각으로 늘어나도 척도가 희석되지 않는다.
 *
 * 사내 정책 4종을 색인하고 관련/무관 화면 쿼리로 측정한 top-1 분포:
 *   관련 화면 (연차/구성원/근태/결재)      0.25 ~ 0.36
 *   무관 화면 (쇼핑/대시보드/로그인/설정)   0.00 ~ 0.15
 */
const IDF_BUDGET_TOKENS = 30;
/** 쿼리 term frequency 포화 상수. 가중치 상한은 idf × (QTF_K + 1). */
const QTF_K = 3;
/** top-1 조차 이 아래면 정책 문서가 다루지 않는 화면으로 보고 빈 결과를 준다. */
const MIN_TOP_RELEVANCE = 0.2;
/**
 * 게이트를 통과한 뒤 청크를 거르는 바닥값. 청크 단위로 MIN_TOP_RELEVANCE 를
 * 그대로 쓰면 "잔여 연차 검증"(0.137) 같은 진짜 관련 청크까지 잘려나가므로,
 * top-1 대비 상대 비율로 완만하게 자른다.
 */
const RELATIVE_FLOOR = 0.5;
const MIN_CHUNK_RELEVANCE = 0.1;

const TERM_GROUPS = [
  ['연차', '휴가', '휴무'],
  ['취소', '철회', 'cancel'],
  ['승인', '결재', '승인선'],
  ['구성원', '직원', '임직원', '멤버'],
  ['조직도', '조직', '조직 트리'],
  ['검색', '조회', '필터'],
  ['반차', '오전 반차', '오후 반차', '반반차'],
];

/** 한글은 형태소 분석기 없이 "어절 + 문자 bigram" 으로 근사한다. */
export function tokenize(text) {
  const out = [];
  const lower = text.toLowerCase();
  const words = lower.match(/[가-힣]+|[a-z0-9]+/g) || [];
  for (const w of words) {
    out.push(w);
    if (/^[가-힣]+$/.test(w) && w.length > 1) {
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    }
  }
  return out;
}

/** 화면 문구와 정책 용어의 표현 차이를 줄인다. */
export function expandQuery(query) {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  const expanded = [normalized];
  for (const group of TERM_GROUPS) {
    if (group.some((term) => lower.includes(term.toLowerCase()))) expanded.push(...group);
  }
  return [...new Set(expanded)].join(' ');
}

export function inferMetadata(chunk) {
  const source = `${chunk.docTitle || ''} ${chunk.sectionPath || ''} ${chunk.text || ''}`.toLowerCase();
  return {
    domains: collectTerms(source, [['휴가', '연차'], ['구성원', '직원', '조직'], ['결재', '승인'], ['근태', '출퇴근']]),
    actions: collectTerms(source, [['취소', '철회'], ['승인', '반려'], ['신청'], ['검색', '조회'], ['변경', '수정']]),
    entities: collectTerms(source, [['연차', '휴가'], ['구성원', '직원'], ['조직도', '조직'], ['승인선', '결재'], ['근무 시간', '출퇴근']]),
  };
}

export class Retriever {
  constructor({ embedder = null } = {}) {
    this.chunks = [];
    this.df = new Map();
    this.docs = [];
    this.avgLen = 0;
    this.embedder = embedder;
    this.vectors = null;
  }

  async index(chunks) {
    this.chunks = chunks;
    this.df = new Map();
    this.docs = chunks.map((c) => {
      const metadata = inferMetadata(c);
      // 문서 제목과 섹션 제목은 검색 신호가 강하므로 본문보다 더 많이 반영한다.
      const tokens = tokenize(`${c.docTitle} ${c.docTitle} ${c.sectionPath} ${c.sectionPath} ${c.text}`);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      return { tf, len: tokens.length, metadata };
    });
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1);

    if (this.embedder) {
      this.vectors = await this.embedder.embedBatch(
        chunks.map((c) => `${c.sectionPath}\n${c.text}`)
      );
    }
    return this.chunks.length;
  }

  idf(token) {
    const df = this.df.get(token) || 0;
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }

  /**
   * 토큰별 쿼리 가중치 = idf × 쿼리 내 빈도(포화).
   * 화면에서 반복되는 말이 한 번만 스치는 전역 내비게이션 항목보다 무겁게 잡힌다.
   * 포화시켜 두어 한 토큰이 쿼리를 독점하지는 못한다 (상한 QTF_K + 1).
   */
  queryWeights(expandedQuery) {
    const qtf = new Map();
    for (const t of tokenize(expandedQuery)) qtf.set(t, (qtf.get(t) || 0) + 1);
    const weights = new Map();
    for (const [t, f] of qtf) weights.set(t, this.idf(t) * (((QTF_K + 1) * f) / (QTF_K + f)));
    return weights;
  }

  /** 쿼리 길이에 좌우되지 않는 관련도 분모: 신호가 가장 강한 토큰들의 가중치 합. */
  relevanceDenominator(weights) {
    const budget = [...weights.values()]
      .sort((a, b) => b - a)
      .slice(0, IDF_BUDGET_TOKENS)
      .reduce((sum, x) => sum + x, 0);
    return Math.max(1e-9, budget);
  }

  bm25(query) {
    const expandedQuery = expandQuery(query);
    const weights = this.queryWeights(expandedQuery);
    const queryMetadata = inferMetadata({ text: expandedQuery });
    const scored = this.docs.map((doc, i) => {
      let score = 0;
      for (const [t, weight] of weights) {
        const f = doc.tf.get(t);
        if (!f) continue;
        score += weight * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (doc.len / this.avgLen))));
      }
      return { i, score, metadataMatches: metadataOverlap(queryMetadata, doc.metadata) };
    });
    return { scored, weights };
  }

  async search(query, topK = 5) {
    if (!this.chunks.length) return [];
    const { scored, weights } = this.bm25(query);
    const denominator = this.relevanceDenominator(weights);

    // relevance 는 쿼리에 상관없이 비교 가능한 절대 관련도다. 컷오프는 여기에만 건다.
    const candidates = scored.map(({ i, score, metadataMatches }) => ({
      i,
      metadataMatches,
      relevance: Math.min(1, score / denominator),
    }));

    // 순위는 임베딩/메타데이터까지 반영하되, 게이트 판정은 relevance 로만 한다.
    // (임베딩은 기본 비활성이고, cos 임계값은 별도 보정 없이는 신뢰할 수 없다.)
    let ranked;
    if (this.embedder && this.vectors) {
      const [qv] = await this.embedder.embedBatch([query]);
      ranked = candidates.map((c) => ({
        ...c,
        rank: HYBRID_ALPHA * c.relevance + (1 - HYBRID_ALPHA) * dot(qv, this.vectors[c.i]) + c.metadataMatches * METADATA_BOOST,
      }));
    } else {
      ranked = candidates.map((c) => ({ ...c, rank: c.relevance + c.metadataMatches * METADATA_BOOST }));
    }

    // 게이트: 어떤 청크도 기준을 넘지 못하면 이 화면을 다루는 정책이 없는 것이다.
    // 여기서 빈 배열을 주어야 호출부가 LLM 에 억지 요약을 시키지 않는다.
    const bestRelevance = Math.max(...ranked.map((item) => item.relevance));
    if (bestRelevance < MIN_TOP_RELEVANCE) return [];

    const floor = Math.max(MIN_CHUNK_RELEVANCE, bestRelevance * RELATIVE_FLOOR);

    return ranked
      .filter((item) => item.relevance >= floor)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, topK)
      .map((item) => ({
        ...this.chunks[item.i],
        metadata: this.docs[item.i].metadata,
        score: Number(item.relevance.toFixed(4)),
      }));
  }
}

function collectTerms(source, groups) {
  return groups.filter((group) => group.some((term) => source.includes(term))).map((group) => group[0]);
}

function metadataOverlap(queryMetadata, documentMetadata) {
  return Object.keys(queryMetadata).reduce(
    (count, key) => count + queryMetadata[key].filter((term) => documentMetadata[key].includes(term)).length,
    0
  );
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** 선택적 임베딩 백엔드 (Voyage). 키가 없으면 null 을 반환해 BM25 단독으로 동작. */
export function createEmbedder() {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  const model = process.env.VOYAGE_MODEL || 'voyage-3';
  return {
    async embedBatch(texts) {
      const vectors = [];
      for (let i = 0; i < texts.length; i += 64) {
        const res = await fetch('https://api.voyageai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ input: texts.slice(i, i + 64), model }),
        });
        if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
        const json = await res.json();
        for (const d of json.data) vectors.push(normalize(d.embedding));
      }
      return vectors;
    },
  };
}

function normalize(v) {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
