import fs from 'node:fs';
import path from 'node:path';

const MAX_CHARS = 900;

/** 마크다운 한 파일을 heading 계층 기준으로 청크로 자른다. */
export function chunkMarkdown(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const fileName = path.basename(filePath);
  const lines = raw.split(/\r?\n/);

  const stack = [];           // [{level, title}]
  const chunks = [];
  let buffer = [];
  let bufferStartLine = 0;

  const sectionPath = () => stack.map((s) => s.title).join(' > ');

  const flush = (endLine) => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;
    const heading = sectionPath();
    // 너무 긴 섹션은 문단 단위로 다시 나눈다.
    const parts = [];
    let cur = '';
    for (const para of text.split(/\n{2,}/)) {
      if ((cur + '\n\n' + para).length > MAX_CHARS && cur) {
        parts.push(cur);
        cur = para;
      } else {
        cur = cur ? cur + '\n\n' + para : para;
      }
    }
    if (cur) parts.push(cur);

    parts.forEach((body, i) => {
      chunks.push({
        id: `${fileName}#${chunks.length}`,
        file: fileName,
        docTitle: stack[0]?.title ?? fileName.replace(/\.md$/, ''),
        sectionPath: heading,
        // 인용 표기용: "연차 신청 정책 > 신청 취소 > 5.1 승인 완료 전 취소"
        citation: heading,
        line: bufferStartLine + 1,
        part: parts.length > 1 ? `${i + 1}/${parts.length}` : null,
        text: body,
      });
    });
    bufferStartLine = endLine;
  };

  lines.forEach((line, idx) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush(idx);
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
      bufferStartLine = idx;
    } else {
      buffer.push(line);
    }
  });
  flush(lines.length);

  return chunks;
}

export function loadPolicyChunks(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .flatMap((f) => chunkMarkdown(path.join(dir, f)));
}
