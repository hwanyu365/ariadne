#!/bin/sh
# 인자 없음: CI 와 같은 검사를 돌리고, 통과하면 그 시점의 작업 트리 해시를 남긴다.
# --check: 커밋 직전 .githooks/pre-commit 이 부른다. 남긴 해시와 지금 작업 트리가 다르면 막는다 → 검증 뒤 고친 채로 커밋하지 않는다.
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

# 커밋 직전 검사는 git 의 pre-commit 이 한다 → hook 경로가 맞지 않으면 검증을 통과로 기록하지 않는다.
sh .claude/hooks/hooks-path.sh || exit 2

full=$(git rev-parse --path-format=absolute --git-path add-verified-full)
skips=.github/verify-skip-paths

# 판정하지 못하면 거짓 → 검증 명령 전체를 돌린다.
skip() {
  base=$(cat "$full" 2>/dev/null) || return 1
  now=$(tree) || return 1
  changed=$(git -c core.quotePath=false diff --name-only --no-renames "$base" "$now") && [ -n "$changed" ] || return 1
  # 범위 파일·이 스크립트가 바뀐 변경은 그 변경 자체를 건너뛰게 할 수 있다.
  printf '%s\n' "$changed" | grep -qxF -e "$skips" -e .claude/hooks/verify.sh && return 1
  # 범위 파일이 없거나 유효한 줄이 없으면 제외가 없어 아래 diff 가 changed 와 같다 → 건너뛰지 않는다.
  pats=$(tr -d '\r' < "$skips" 2>/dev/null | sed 's/[[:space:]]*$//' | grep -vE '^(#|$)')
  set --
  while IFS= read -r p; do
    [ -n "$p" ] && set -- "$@" ":(exclude)$p"
  done <<EOF
$pats
EOF
  # pathspec 은 이름 바꾸기 감지보다 먼저 적용된다 → 범위 밖에서 옮겨 온 파일의 원래 경로가 남는다.
  out=$(git diff --name-only "$base" "$now" -- . "$@") && [ -z "$out" ]
}

rm -f "$stamp"
if git rev-parse -q --verify origin/main >/dev/null; then sh .github/spec-trace.sh -b origin/main; else sh .github/spec-trace.sh; fi || exit
if skip; then
  echo "검증 명령 건너뜀 → 마지막 전체 통과($base) 뒤 바뀐 파일이 모두 $skips 범위:"
  printf '  %s\n' "$changed"
  printf '%s\n' "$now" > "$stamp" || { rm -f "$stamp"; echo "작업 트리 해시를 기록하지 못함" >&2; exit 1; }
  echo "검증 통과 → $now"
  exit 0
fi
# CI 의 run 단계와 같은 셸 규칙(-e)으로 서브셸에서 돌린다 → 검증 명령의 cd 가 아래 해시 기록에 번지지 않는다.
# 서브셸을 || 뒤에 두면 -e 가 꺼지므로 종료 코드는 따로 본다.
(
set -e
npm run verify
)
r=$?
[ "$r" -eq 0 ] || exit "$r"
tree > "$stamp" || { rm -f "$stamp"; echo "작업 트리 해시를 기록하지 못함" >&2; exit 1; }
cp "$stamp" "$full" || rm -f "$full"
echo "검증 통과 → $(cat "$stamp")"
