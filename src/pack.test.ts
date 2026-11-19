import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { packExt, zipName } from './pack';
import { EXT_DIR, Ext } from './test/ext';
import { tempDir } from './test/serve';

const ROOT = path.join(__dirname, '..');
const pkgVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;

/** zip 의 파일 이름과 내용. 중앙 디렉터리를 읽는다. */
function readZip(file: string): Map<string, Buffer> {
  const b = fs.readFileSync(file);
  const end = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = b.readUInt16LE(end + 10);
  let at = b.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = b.readUInt16LE(at + 10), size = b.readUInt32LE(at + 20), nameLen = b.readUInt16LE(at + 28);
    const extra = b.readUInt16LE(at + 30), comment = b.readUInt16LE(at + 32), local = b.readUInt32LE(at + 42);
    const name = b.toString('utf8', at + 46, at + 46 + nameLen);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

test('TC#87 extZipHoldsOnlyExtensionFilesAndLoads', async () => {
  assert.equal(zipName('1.2.3'), 'ariadne-1.2.3-chrome.zip');
  const out = path.join(tempDir(), zipName(pkgVersion()));
  await packExt(EXT_DIR, out, pkgVersion());
  const files = readZip(out);
  const names = [...files.keys()].sort();
  for (const top of ['manifest.json', 'panel.html', 'panel.css', 'icon.png', 'tick.js']) assert.ok(names.includes(top), top);
  assert.ok(names.includes('dist/ext/sw.js') && names.includes('dist/ext/ui.js') && names.includes('dist/core/engine.js'), names.join(', '));
  const extra = names.filter(n => !/^(manifest\.json|panel\.html|panel\.css|icon\.png|tick\.js|dist\/(ext|core)\/[\w-]+\.js)$/.test(n));
  assert.deepEqual(extra, []);
  assert.ok(!names.some(n => n.endsWith('.test.js')));
  assert.deepEqual(files.get('icon.png'), fs.readFileSync(path.join(EXT_DIR, 'icon.png')));
  assert.equal(files.get('dist/ext/ui.js')!.toString('utf8'), fs.readFileSync(path.join(EXT_DIR, 'dist/ext/ui.js'), 'utf8'));

  // 푼 폴더를 그대로 올리면 서비스 워커가 뜨고 패널 화면이 열린다.
  const dir = tempDir();
  for (const [name, data] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  const x = await Ext.launch(dir);
  try {
    const ui = await x.ctx.newPage();
    await ui.goto(`chrome-extension://${x.id}/panel.html`);
    await ui.waitForFunction(() => document.body.dataset.ready === '1', undefined, { timeout: 10000, polling: 50 });
    assert.equal(await ui.evaluate(() => chrome.runtime.getManifest().version), pkgVersion());
  } finally {
    x.close();
  }
});

test('TC#87 extZipFailsWhenAFileIsMissing', async () => {
  const dir = tempDir();
  fs.cpSync(EXT_DIR, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'panel.css'));
  const out = path.join(tempDir(), 'x.zip');
  await assert.rejects(packExt(dir, out, pkgVersion()), /panel\.css/);
  assert.equal(fs.existsSync(out), false);
  fs.cpSync(EXT_DIR, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'dist', 'ext', 'sw.js'));
  await assert.rejects(packExt(dir, out, pkgVersion()), /sw\.js/);
  assert.equal(fs.existsSync(out), false);
});

test('TC#88 extVersionMatchesPackage', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, pkgVersion());
  assert.equal(manifest.minimum_chrome_version, '126');
  const out = path.join(tempDir(), 'x.zip');
  await assert.rejects(packExt(EXT_DIR, out, '9.9.9'), /버전/);
  assert.equal(fs.existsSync(out), false);
});
