import assert from 'node:assert/strict';
import { test } from 'node:test';
import { charsetWarning, checkCharset } from './charset';

test('charsetNameChecked', () => {
  assert.equal(checkCharset('  '), null);
  assert.equal(checkCharset(' utf-8 '), 'utf-8');
  assert.equal(checkCharset('euc-kr'), 'euc-kr');
  // 브라우저가 모르는 이름(u8, base64)도 여기서 거른다 → 지정이 조용히 무시되는 경로가 없다.
  for (const bad of ['nope', 'utf-8\r\nx-evil: 1', 'utf\r\n8', 'utf 8', 'base64', 'u8']) {
    assert.throws(() => checkCharset(bad), /인코딩/, bad);
  }
});

test('charsetWarningJudgesOriginalBytes', () => {
  const utf8 = Buffer.from('본문 가나다');
  assert.match(charsetWarning('windows-1252', utf8, null) ?? '', /windows-1252/);
  assert.match(charsetWarning('EUC-KR', utf8, 'euc-kr') ?? '', /'euc-kr'.*EUC-KR/);
  assert.equal(charsetWarning('UTF-8', utf8, null), null);
  assert.equal(charsetWarning('windows-1252', Buffer.from('plain'), null), null);           // ASCII 는 어느 인코딩으로 읽어도 같다
  assert.equal(charsetWarning('EUC-KR', Buffer.from([0xb0, 0xa1, 0xb3, 0xaa]), null), null); // UTF-8 이 아닌 바이트
  assert.equal(charsetWarning('windows-1252', Buffer.alloc(0), null), null);
});
