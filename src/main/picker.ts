// 셀렉터를 맞추는 게 이 도구의 유일한 삽질 지점이라, probe 가 후보를 찾아 준다.
export const NEXT_CANDIDATES_JS = `() => {
  const sel = el => el.id ? '#' + el.id
    : (typeof el.className === 'string' && el.className.trim()
        ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).join('.')
        : el.tagName.toLowerCase());
  const pat = /다음|next|더보기|▶|›|»|→|>>/i;
  return [...document.querySelectorAll('a, button, input[type=button], input[type=submit]')]
    .filter(e => pat.test((e.innerText || '') + ' ' + (e.title || '') + ' ' + (e.className || '') + ' ' + (e.value || '')))
    .slice(0, 10)
    .map(e => ({ sel: sel(e), text: (e.innerText || e.value || '').trim().slice(0, 20), href: (e.getAttribute('href') || '').slice(0, 60) }));
}`;

export const TEXT_CANDIDATES_JS = `() => {
  const sel = el => el.id ? '#' + el.id
    : (typeof el.className === 'string' && el.className.trim()
        ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).join('.')
        : el.tagName.toLowerCase());
  return [...document.querySelectorAll('div, article, section, td, p')]
    .map(e => ({ sel: sel(e), len: (e.innerText || '').trim().length }))
    .filter(x => x.len > 200)
    .sort((a, b) => a.len - b.len)   // 가장 짧은 쪽이 본문에 가장 가까운 컨테이너다
    .slice(0, 6);
}`;

export const IMAGE_CANDIDATES_JS = `() => {
  const sel = el => el.id ? '#' + el.id
    : (typeof el.className === 'string' && el.className.trim()
        ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).join('.')
        : el.tagName.toLowerCase());
  const byParent = new Map();
  for (const img of document.querySelectorAll('img')) {
    const p = img.parentElement;
    if (!p) continue;
    const k = sel(p);
    const v = byParent.get(k) || { sel: k + ' img', n: 0, big: 0 };
    v.n++;
    if (img.naturalWidth >= 300) v.big++;
    byParent.set(k, v);
  }
  return [...byParent.values()].sort((a, b) => b.big - a.big || b.n - a.n).slice(0, 6);
}`;

// 아래 두 JS 는 `data-ariadne-ui` 를 공유한다. 선택기가 붙인 요소를 매치 수와 선택 대상에서 빼는 표식이다.
// 클릭한 요소 하나에서 셀렉터 후보를 만든다. 매치 수를 함께 내어 상태 클래스가 섞였는지 드러낸다.
export const CANDIDATES_JS = `el => {
  const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
  const classesOf = e => (typeof e.className === 'string'
    ? e.className.trim().split(/\\s+/).filter(Boolean) : []);
  const out = [];
  const add = s => { if (s && out.indexOf(s) < 0) out.push(s); };
  const tag = el.tagName.toLowerCase();

  if (el.id) add('#' + esc(el.id));
  const cs = classesOf(el);
  if (cs.length) {
    add(tag + '.' + cs.map(esc).join('.'));
    if (cs.length > 1) add(tag + '.' + esc(cs[0]));   // 상태 클래스가 섞였을 때를 위한 짧은 쪽
  }
  if (tag === 'img') {
    // 이미지는 그 한 장이 아니라 컨테이너를 집어야 다음 페이지에서도 맞는다.
    const p = el.parentElement;
    if (p) {
      if (p.id) add('#' + esc(p.id) + ' img');
      const pcs = classesOf(p);
      if (pcs.length) add(p.tagName.toLowerCase() + '.' + pcs.map(esc).join('.') + ' img');
    }
  }
  add(tag);

  const count = s => {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(s))
        .filter(e => !e.closest('[data-ariadne-ui]')).length;
    } catch (_) { return 0; }
  };
  return out.map(sel => ({ sel: sel, n: count(sel) }));
}`;

// 하이라이트·툴바를 붙이고 클릭을 가로챈다. 페이지 동작을 바꾸지 않도록 전부 fixed 로 띄운다.
export const PICKER_JS = `function install(opts) {
  // 광고·임베드마다 툴바가 붙으면 페이지를 쓸 수 없고, iframe 안은 수집 대상도 아니다 (docs/specification.md 제외 범위).
  if (window !== window.top) return;
  const targets = (opts && opts.targets) || ['본문', 'next', '제목'];
  const UI = 'data-ariadne-ui';
  let current = targets[0];

  // 가드는 설치가 끝난 뒤에 세운다. 앞에 두면 실패한 설치가 재설치를 막는다.
  if (window.__ariadnePicker) return;

  const mk = (tag, css) => {
    const e = document.createElement(tag);
    e.setAttribute(UI, '');
    Object.assign(e.style, css);
    return e;
  };

  const box = mk('div', {position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
    border: '2px solid #e11', background: 'rgba(238,17,17,.12)', display: 'none'});
  const bar = mk('div', {position: 'fixed', zIndex: '2147483647',
    maxWidth: '520px', padding: '8px 10px', font: '13px/1.5 sans-serif', color: '#111',
    background: '#fff', border: '1px solid #888', borderRadius: '6px',
    boxShadow: '0 2px 10px rgba(0,0,0,.25)'});
  // 툴바가 고르려는 요소를 덮으면 클릭이 툴바로 간다. 기본은 아래쪽, 겹치면 사용자가 옮긴다.
  let atTop = false;
  const place = () => Object.assign(bar.style, atTop
    ? {left: '12px', right: 'auto', top: '12px', bottom: 'auto'}
    : {left: 'auto', right: '12px', top: 'auto', bottom: '12px'});
  place();
  const head = mk('div', {marginBottom: '4px'});
  const list = mk('div', {});
  bar.appendChild(head); bar.appendChild(list);
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(bar);

  const btn = (label, on, active) => {
    const b = mk('button', {margin: '0 4px 0 0', padding: '2px 8px', cursor: 'pointer',
      font: 'inherit', border: '1px solid #888', borderRadius: '4px',
      background: active ? '#135' : '#eee', color: active ? '#fff' : '#111'});
    b.textContent = label;
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (e.isTrusted) on(); }, true);
    return b;
  };

  const send = payload => { if (window.__ariadne_pick) window.__ariadne_pick(payload); };

  const drawHead = () => {
    head.textContent = '';
    head.appendChild(document.createTextNode('고를 대상: '));
    targets.forEach(t => head.appendChild(btn(t, () => { current = t; drawHead(); }, t === current)));
    head.appendChild(btn('↕ 위치', () => { atTop = !atTop; place(); }, false));
    head.appendChild(btn('완료', () => { if (window.__ariadne_done) window.__ariadne_done(); }, false));
  };

  const drawList = (cands, text) => {
    list.textContent = '';
    if (!cands.length) { list.textContent = '후보를 만들지 못했다.'; return; }
    const t = mk('div', {color: '#555', marginBottom: '2px'});
    t.textContent = text ? '"' + text.slice(0, 40) + '"' : '';
    list.appendChild(t);
    cands.forEach((c, i) => {
      const mark = c.n === 1 ? ' \\u2713' : ' \\u26a0';
      const row = btn(c.sel + ' \\u2014 ' + c.n + '개' + mark,
        () => send({target: current, sel: c.sel, candidates: cands, text: text}), i === 0);
      Object.assign(row.style, {display: 'block', width: '100%', textAlign: 'left', margin: '2px 0'});
      list.appendChild(row);
    });
  };

  document.addEventListener('mouseover', e => {
    if (e.target.closest('[' + UI + ']')) return;
    const r = e.target.getBoundingClientRect();
    Object.assign(box.style, {display: 'block', left: r.left + 'px', top: r.top + 'px',
      width: r.width + 'px', height: r.height + 'px'});
  }, true);

  document.addEventListener('click', e => {
    // 핸들러는 격리 world 에 있어도 DOM 이벤트는 페이지가 합성할 수 있다 → 사람이 누른 것만 선택으로 센다.
    if (!e.isTrusted) return;
    if (e.target.closest('[' + UI + ']')) return;   // 툴바 자신의 클릭은 그대로 둔다
    e.preventDefault(); e.stopPropagation();        // 링크 이동과 폼 전송을 막는다
    const el = e.target;
    const cands = window.__ariadneCandidates(el);
    const text = (el.innerText || el.getAttribute('src') || '').trim();
    drawList(cands, text);
    send({target: current, sel: cands.length ? cands[0].sel : '', candidates: cands, text: text});
  }, true);

  drawHead();
  window.__ariadnePicker = true;
}`;

/** 후보 생성 함수와 선택기를 한 번에 세우는 스크립트. 둘을 따로 넣으면 클릭 핸들러가 조용히 죽는다. */
export function pickerSetupJs(targets: readonly string[]): string {
  return `(() => { window.__ariadneCandidates = ${CANDIDATES_JS}; (${PICKER_JS})(${JSON.stringify({ targets })}); })()`;
}
