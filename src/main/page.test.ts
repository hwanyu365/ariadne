import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickPolicy, referrerFor } from './page';

test('referrerFollowsPolicyLikeBrowser', () => {
  // 브라우저가 그 정책으로 보내는 값과 같다. 정책이 없으면 기본 정책(strict-origin-when-cross-origin)이다.
  const page = 'https://a.test/ep/1?no=2#x';
  const cases: [string, string, string, string | null][] = [
    [page, 'https://a.test/i.png', '', 'https://a.test/ep/1?no=2'],
    [page, 'https://cdn.test/i.png', '', 'https://a.test/'],
    [page, 'https://a.test:8443/i.png', '', 'https://a.test/'],
    [page, 'http://cdn.test/i.png', '', null],
    ['http://a.test/ep/1', 'https://cdn.test/i.png', '', 'http://a.test/'],
    [page, 'https://cdn.test/i.png', 'no-referrer', null],
    [page, 'https://cdn.test/i.png', 'unsafe-url', 'https://a.test/ep/1?no=2'],
    [page, 'http://cdn.test/i.png', 'unsafe-url', 'https://a.test/ep/1?no=2'],
    [page, 'https://cdn.test/i.png', 'origin', 'https://a.test/'],
    [page, 'https://a.test/i.png', 'origin', 'https://a.test/'],
    [page, 'https://cdn.test/i.png', 'same-origin', null],
    [page, 'https://a.test/i.png', 'same-origin', 'https://a.test/ep/1?no=2'],
    [page, 'https://cdn.test/i.png', 'origin-when-cross-origin', 'https://a.test/'],
    [page, 'http://cdn.test/i.png', 'strict-origin', null],
    [page, 'https://cdn.test/i.png', 'strict-origin', 'https://a.test/'],
    [page, 'https://cdn.test/i.png', 'no-referrer-when-downgrade', 'https://a.test/ep/1?no=2'],
    [page, 'http://cdn.test/i.png', 'no-referrer-when-downgrade', null],
    // 여러 값이면 마지막 아는 값을, 모르는 값만 있으면 기본 정책을 쓴다.
    [page, 'https://cdn.test/i.png', 'unsafe-url, bogus', 'https://a.test/ep/1?no=2'],
    [page, 'https://cdn.test/i.png', 'bogus', 'https://a.test/'],
    // 자격 증명은 싣지 않는다.
    ['https://u:p@a.test/ep', 'https://a.test/i.png', '', 'https://a.test/ep'],
    ['file:///C:/d/p.html', 'file:///C:/d/i.png', '', null],
    ['not a url', 'https://a.test/i.png', '', null],
  ];
  for (const [from, to, policy, want] of cases) assert.equal(referrerFor(from, to, policy), want, `${from} -> ${to} [${policy}]`);
});

test('policyFallsThroughUnknownValues', () => {
  // 요소 속성 → meta → 헤더 순으로, 아는 값이 든 첫 단계를 쓴다. 모르는 값만 있는 단계는 건너뛴다.
  assert.equal(pickPolicy('bogus', '', 'no-referrer'), 'no-referrer');
  assert.equal(pickPolicy('', 'unsafe-url', 'no-referrer'), 'unsafe-url');
  assert.equal(pickPolicy('origin', 'unsafe-url', 'no-referrer'), 'origin');
  assert.equal(pickPolicy('bogus, same-origin', '', ''), 'same-origin');
  assert.equal(pickPolicy('', 'bogus', ''), '');
});
