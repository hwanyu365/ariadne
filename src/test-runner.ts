import fs from 'node:fs';
import path from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.test.js') ? [path.join(dir, e.name)] : []);

// 소스 경로(src/…/x.test.ts)를 주면 그 파일만 돌린다 → 개발 중 확인을 빠르게 한다. 검증 명령은 인자 없이 전체를 돈다.
const only = process.argv.slice(2).filter(a => a.endsWith('.test.ts'))
  .map(a => path.join(__dirname, path.relative('src', a).replace(/\.ts$/, '.js')));
const all = only.length ? only : files(__dirname);
// 확장을 올린 Chromium 하나를 모든 테스트 파일이 같이 쓴다 → 같은 프로세스에서 차례로 돈다.
// 결함이 있으면 브라우저 쪽 기다림이 끝나지 않는 테스트가 있다 → 매달리지 않고 실패로 끝낸다.
const stream = run({ files: all, isolation: 'none', concurrency: 1, timeout: 60000 });
// 띄운 Chromium 이 이벤트 루프를 붙잡아 프로세스가 스스로 끝나지 않는다.
// 파일은 차례로 로드되므로, 모든 파일이 테스트를 등록했고 등록한 것이 모두 끝났을 때를 끝으로 본다.
const started = new Set<string>();
let queued = 0, completed = 0, failed = 0;
const finish = () => {
  console.log(`\n${completed - failed}개 통과, ${failed}개 실패 (파일 ${started.size}/${all.length})`);
  process.exit(failed || !completed ? 1 : 0);
};
stream.on('test:enqueue', d => {
  if (d.nesting !== 0) return;
  queued++;
  if (d.file) started.add(d.file);
});
stream.on('test:complete', d => {
  if (d.nesting !== 0) return;
  completed++;
  if (!d.details.passed) {
    failed++;
    // 요약을 기다리지 않고 끝내므로 실패 사유는 여기서 바로 남긴다.
    console.error(`\n✖ ${d.name}\n${d.details.error?.cause ?? d.details.error}`);
    // 엔진 테스트는 로그를 남기지 않는 것이 많다 → 마지막 엔진 호출의 로그를 함께 보여 멈춘 사유를 남긴다.
    const adapter = require.cache[path.join(__dirname, 'test', 'engine.js')]?.exports as { lastLogs?: () => readonly string[] } | undefined;
    const logs = adapter?.lastLogs?.() ?? [];
    if (logs.length) console.error(`  마지막 엔진 호출의 로그:\n${logs.map(l => `    ${l}`).join('\n')}`);
  }
  if (completed === queued && started.size === all.length) setImmediate(finish);
});
stream.compose(spec).pipe(process.stdout);
