import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// 확장이 쓰는 파일만 담는다 → 테스트·소스가 사용자 Chrome 에 올라가지 않는다.
const FILES = ['manifest.json', 'panel.html', 'panel.css', 'icon.png', 'tick.js'];
const SCRIPTS = ['dist/ext', 'dist/core'];
const ENTRY = ['dist/ext/sw.js', 'dist/ext/ui.js'];

function crc32(data: Buffer): number {
  let c = ~0;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function zip(entries: [string, Buffer][]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const body = zlib.deflateRawSync(data);
    const fname = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    // 날짜 0 은 압축 도구마다 다르게 읽는다 → 1980-01-01 로 고정해 같은 입력이 같은 zip 이 되게 한다.
    head.writeUInt16LE(0x21, 12);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(fname.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    head.copy(dir, 8, 6, 30);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, fname, body);
    central.push(dir, fname);
    offset += head.length + fname.length + body.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** Release 에 붙는 확장 zip 이름. */
export const zipName = (version: string) => `ariadne-${version}-chrome.zip`;

/** 확장 폴더를 zip 하나로 묶는다. 빠진 파일이 있거나 manifest 버전이 version 과 다르면 만들지 않는다. */
export async function packExt(extDir: string, out: string, version: string): Promise<void> {
  for (const f of [...FILES, ...ENTRY])
    if (!fs.existsSync(path.join(extDir, f))) throw new Error(`확장 파일이 없습니다: ${f} (npm run build 를 먼저 하세요)`);
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`manifest 버전 ${manifest.version} 이 package.json 버전 ${version} 과 다릅니다.`);
  const scripts = SCRIPTS.flatMap(d => fs.readdirSync(path.join(extDir, d)).filter(n => n.endsWith('.js')).sort().map(n => `${d}/${n}`));
  const entries = [...FILES, ...scripts].map(n => [n, fs.readFileSync(path.join(extDir, n))] as [string, Buffer]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zip(entries));
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  const out = path.join(root, 'release', zipName(version));
  packExt(path.join(root, 'ext'), out, version).then(() => console.log(out), e => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
