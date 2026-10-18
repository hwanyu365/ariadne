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
  const stream = run({ files: files(__dirname), isolation: 'none', concurrency: 1 });
  // 같은 프로세스 실행은 프로세스가 끝날 때 요약을 낸다 → Electron 에서는 오지 않으므로 최상위 테스트 수로 끝을 판정한다.
  let queued = 0, completed = 0, failed = 0, idle: NodeJS.Timeout | undefined;
  const finish = () => {
    console.log(`\n${completed - failed}개 통과, ${failed}개 실패`);
    app.exit(failed || !completed ? 1 : 0);
  };
  stream.on('test:enqueue', d => { if (d.nesting === 0) queued++; clearTimeout(idle); });
  stream.on('test:complete', d => {
    if (d.nesting !== 0) return;
    completed++;
    if (!d.details.passed) {
      failed++;
      // 요약을 기다리지 않고 끝내므로 실패 사유는 여기서 바로 남긴다.
      console.error(`\n✖ ${d.name}\n${d.details.error?.cause ?? d.details.error}`);
    }
    if (completed === queued) idle = setTimeout(finish, 500);
  });
  stream.compose(spec).pipe(process.stdout);
});
