import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

// 엔진 테스트는 BrowserWindow 가 필요해 Electron main 안에서 돈다. 순수 함수 테스트도 같은 명령으로 함께 돌린다.
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.test.js') ? [path.join(dir, e.name)] : []);

app.on('window-all-closed', () => {});    // 테스트 창을 닫을 때마다 앱이 종료되지 않게 한다
app.whenReady().then(() => {
  const all = files(__dirname);
  const stream = run({ files: all, isolation: 'none', concurrency: 1 });
  // 같은 프로세스 실행은 프로세스가 끝날 때 요약을 낸다 → Electron 에서는 오지 않는다.
  // 파일은 차례로 로드되므로, 모든 파일이 테스트를 등록했고 등록한 것이 모두 끝났을 때를 끝으로 본다.
  const started = new Set<string>();
  let queued = 0, completed = 0, failed = 0;
  const finish = () => {
    console.log(`\n${completed - failed}개 통과, ${failed}개 실패 (파일 ${started.size}/${all.length})`);
    app.exit(failed || !completed ? 1 : 0);
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
    }
    if (completed === queued && started.size === all.length) setImmediate(finish);
  });
  stream.compose(spec).pipe(process.stdout);
});
