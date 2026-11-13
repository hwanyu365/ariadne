#!/bin/sh
# git hook 경로를 .githooks 로 맞춘다 → hook 경로는 클론마다 로컬 설정이라, 세션 시작 hook 과 verify.sh 가 부른다.
# 이미 다른 경로이거나 .git/hooks 에 기존 hook 이 있으면 바꾸지 않고 실패한다 → 기존 hook 이 조용히 꺼지지 않게 사람이 정리한다.
# --check: 커밋 명령 직전 hook. 설정을 바꾸지 않고, pre-commit 이 돌 상태가 아니면 막는다 → hook 경로가 틀린 클론에서 커밋이 조용히 통과하지 않는다.
cd "$(git rev-parse --show-toplevel)" || exit 2
hp=$(git config --get core.hooksPath)
if [ "${1-}" = --check ]; then
  [ "$hp" = .githooks ] && [ -x .githooks/pre-commit ] && exit 0
  echo "core.hooksPath 가 .githooks 가 아니거나 .githooks/pre-commit 을 실행할 수 없음 → 커밋 검사가 돌지 않으므로 커밋 차단. sh .claude/hooks/hooks-path.sh 의 안내를 따른다" >&2
  exit 2
fi
case "$hp" in
  .githooks) ;;
  "")
    own=$(ls "$(git rev-parse --path-format=absolute --git-common-dir)/hooks" 2>/dev/null | grep -v '\.sample$' | tr '\n' ' ')
    [ -z "$own" ] || { echo ".git/hooks 에 기존 hook($own)이 있음 → hook 경로를 바꾸면 꺼진다. 사람이 .githooks 로 옮긴 뒤 core.hooksPath 를 .githooks 로 설정한다" >&2; exit 2; }
    git config core.hooksPath .githooks || exit 2 ;;
  *) echo "core.hooksPath 가 $hp → .githooks/pre-commit 이 돌지 않음. 사람이 core.hooksPath 를 .githooks 로 되돌린다" >&2; exit 2 ;;
esac
[ -f .githooks/pre-commit ] || { echo ".githooks/pre-commit 없음" >&2; exit 2; }
# 실행 권한이 빠지면 git 이 hook 을 조용히 건너뛴다.
[ -x .githooks/pre-commit ] || chmod +x .githooks/pre-commit || exit 2
