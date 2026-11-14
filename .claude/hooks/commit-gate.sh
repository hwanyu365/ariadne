#!/bin/sh
# 모든 Bash 명령 직전 hook: git commit 에 pre-commit 을 끄는 옵션이 있거나, git 설정 옵션이 hook 경로·alias 를 바꾸면 exit 2 로 막는다.
# 검사 본체(비밀 파일·검증 기록)는 pre-commit 에 있다 → 여기서는 그것을 끄는 경로를 옵션 해석으로 막는다. deny 규칙은 문자열 거부 목록이라 묶음 옵션 같은 변형이 통과한다.
deny() { echo "커밋 차단: $*" >&2; exit 2; }
pass() { exit 0; }
here=$(cd "$(dirname "$0")" && pwd)
. "$here/hook-lib.sh"
load commit

# 짧은 옵션 낱말은 글자를 차례로 읽는다. 값을 받는 글자 뒤의 나머지는 값이고, 나머지가 없으면 다음 낱말이 값이다(want).
short() {
  s=${1#-}
  while [ -n "$s" ]; do
    c=${s%"${s#?}"}; s=${s#?}
    case $c in
      n) deny "git commit 의 -n 은 pre-commit 을 건너뛴다 ($1)" ;;
      m|F|C|c|t) [ -n "$s" ] || want=1; return ;;
      u|S) return ;;
    esac
  done
}
cfg() {
  k=$(printf '%s' "${1%%=*}" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  case $k in core.hookspath|alias.*|include.*|includeif.*) deny "git 설정 $k 는 hook 경로나 하위 명령을 바꾼다" ;; esac
}

while IFS= read -r line; do
  old=$IFS; IFS=$us; set -f; set -- $line; set +f; IFS=$old
  [ "${1-}" = S ] || continue; shift
  unwrap "$@"; shift "$drop"
  [ $# -gt 0 ] || continue
  case ${1##*/} in git|git.exe) shift ;; *) continue ;; esac
  sub=""
  while [ $# -gt 0 ]; do
    case $1 in
      -c|--config-env) [ $# -ge 2 ] || break; cfg "$2"; shift 2 ;;
      --config-env=*) cfg "${1#--config-env=}"; shift ;;
      -c*) cfg "${1#-c}"; shift ;;
      -C|--git-dir|--work-tree|--namespace) shift; [ $# -gt 0 ] && shift ;;
      -*) shift ;;
      *) sub=$1; shift; break ;;
    esac
  done
  # 설정 이름은 대소문자를 가리지 않는다 → deny 의 철자 규칙을 지나 같은 명령 안에서 hook 경로를 바꾸고 커밋할 수 있다.
  if [ "$sub" = config ]; then for a in "$@"; do cfg "$a"; done; continue; fi
  [ "$sub" = commit ] || continue
  # 값을 받는 긴 옵션은 정확한 이름만 다음 낱말을 건너뛴다 → 모르는 옵션을 값으로 오인해 뒤의 -n 을 놓치지 않는다.
  want=""; end=""
  for a in "$@"; do
    if [ -n "$want" ]; then want=""; continue; fi
    [ -z "$end" ] || continue
    case $a in
      --) end=1 ;;
      --no-veri*) case --no-verify in "$a"*) deny "git commit 의 $a 는 pre-commit 을 건너뛴다" ;; esac ;;
      --message|--file|--template|--reuse-message|--reedit-message|--fixup|--squash|--author|--date|--cleanup|--trailer|--pathspec-from-file) want=1 ;;
      --*) ;;
      -?*) short "$a" ;;
    esac
  done
done <<EOS
$segs
EOS
exit 0
