#!/bin/sh
# 인자 없음: CI 와 같은 검사를 돌리고, 통과하면 그 시점의 작업 트리 해시를 남긴다.
# --check: 커밋 직전 hook. 남긴 해시와 지금 작업 트리가 다르면 막는다 → 검증 뒤 고친 채로 커밋하지 않는다.
cd "$(git rev-parse --show-toplevel)" || exit 2
stamp=$(git rev-parse --path-format=absolute --git-path add-verified)

# 미추적 파일까지 담은 tree 해시. 임시 index 를 써서 사용자의 stage 상태는 건드리지 않는다.
tree() {
  i=$(git rev-parse --git-path add-index)
  # index 가 아직 없으면 임시 index 도 두지 않는다 → 빈 파일은 git 이 손상된 index 로 거부한다.
  cp "$(git rev-parse --git-path index)" "$i" 2>/dev/null || rm -f "$i"
  GIT_INDEX_FILE="$i" git add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$i" git write-tree
  r=$?; rm -f "$i"; return $r
}

if [ "${1-}" = --check ]; then
  now=$(tree) || { echo "작업 트리 해시를 구하지 못함 → 커밋 차단" >&2; exit 2; }
  [ "$(cat "$stamp" 2>/dev/null)" = "$now" ] && exit 0
  echo "검증 통과 뒤 작업 트리가 바뀌었거나 검증을 돌리지 않음 → 커밋 차단. sh .claude/hooks/verify.sh 를 다시 실행한다" >&2
  exit 2
fi

rm -f "$stamp"
if git rev-parse -q --verify origin/main >/dev/null; then sh .github/spec-trace.sh -b origin/main; else sh .github/spec-trace.sh; fi || exit
# CI 의 run 단계와 같은 셸 규칙(-e)으로 서브셸에서 돌린다 → 검증 명령의 cd 가 아래 해시 기록에 번지지 않는다.
# 서브셸을 || 뒤에 두면 -e 가 꺼지므로 종료 코드는 따로 본다.
(
set -e
npm run verify
)
r=$?
[ "$r" -eq 0 ] || exit "$r"
tree > "$stamp" || { rm -f "$stamp"; echo "작업 트리 해시를 기록하지 못함" >&2; exit 1; }
echo "검증 통과 → $(cat "$stamp")"
