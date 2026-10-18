/** 비었으면 null. 이름이 응답 헤더에 그대로 들어가므로 모르는 이름은 여기서 막는다. */
export function checkCharset(name: string): string | null {
  name = name.trim();
  if (!name) return null;
  const bad = new Error(`알 수 없는 인코딩: '${name}' (예: utf-8, euc-kr)`);
  // TextDecoder 는 이름 앞뒤 공백을 받아 준다 → 헤더에 넣기 전에 문자 집합부터 거른다.
  if (!/^[A-Za-z0-9._:-]+$/.test(name)) throw bad;
  // TextDecoder 와 브라우저는 같은 인코딩 이름 표(WHATWG)를 쓴다 → 여기를 통과한 이름은 브라우저도 적용한다.
  try {
    new TextDecoder(name);
  } catch {
    throw bad;
  }
  return name;
}

/** 틀린 인코딩으로 읽어도 수집은 깨진 채 성공한다 → 조용히 지나가지 않게 로그 문구를 만든다. */
export function charsetWarning(actual: string, body: Buffer, charset: string | null): string | null {
  // 브라우저가 고른 인코딩 이름으로는 판정할 수 없다. 선언이 없을 때 쓰는 기본값이 환경에 따라 바뀐다.
  // 비ASCII 를 담은 올바른 UTF-8 바이트가 다른 인코딩의 글이기는 어렵다 → 원래 바이트로 판정한다.
  if (actual === 'UTF-8' || body.every(b => b < 0x80)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
  if (charset) return `  경고: 페이지는 utf-8 로 보이는데 지정한 인코딩 '${charset}' 로 받아 ${actual} 로 읽었다. 인코딩을 utf-8 로 지정하라.`;
  return `  경고: 페이지는 utf-8 로 보이는데 브라우저가 ${actual} 로 읽었다. 글자가 깨졌으면 인코딩을 utf-8 로 지정해 다시 받아라.`;
}
