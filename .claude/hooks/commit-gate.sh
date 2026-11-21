#!/bin/sh
# 모든 Bash 명령 직전 hook: git commit 에 pre-commit 을 끄는 옵션이나 다른 저장소 지정이 있거나, git 설정 옵션·환경변수가 hook 경로·alias 를 바꾸면 exit 2 로 막는다.
# 검사 본체(비밀 파일·검증 기록)는 pre-commit 에 있다 → 여기서는 그것을 끄는 경로를 옵션 해석으로 막는다. deny 규칙은 문자열 거부 목록이라 묶음 옵션 같은 변형이 통과한다.
deny() { echo "커밋 차단: $*" | tr -d '\002\003' >&2; exit 2; }
pass() { exit 0; }
here=$(cd "$(dirname "$0")" && pwd)
. "$here/hook-lib.sh"
load commit
xu=$(printf '\002'); xq=$(printf '\003'); xc='[$`]'

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
# 따옴표 안 확장 낱말이 옵션 자리에 오면, 확장 앞의 글자가 값을 받는 옵션이거나 - 가 아닌 글자일 때만 옵션이 될 수 없다.
xarg() {
  p=${1%%$xc*}
  case $p in
    --*=*) return ;;
    --*) ;;
    -?*)
      s=${p#-}
      while [ -n "$s" ]; do
        c=${s%"${s#?}"}; s=${s#?}
        case $c in n) deny "git commit 의 -n 은 pre-commit 을 건너뛴다 ($1)" ;; S|u|m|F|C|c|t) return ;; esac
      done ;;
    -*|'') ;;
    *) return ;;
  esac
  deny "git commit 의 $1 는 실행할 때 정해져 옵션이 될 수 있음"
}
cfg() {
  case $1 in *"$xu"*) deny "git 설정 $1 는 실행할 때 정해져 쪼개질 수 있음 → 값을 \"…\" 로 감싼다" ;; esac
  case ${1%%=*} in *$xc*) deny "git 설정 이름 ${1%%=*} 는 실행할 때 정해짐" ;; esac
  k=$(printf '%s' "${1%%=*}" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  case $k in core.hookspath|help.autocorrect|alias.*|include.*|includeif.*) deny "git 설정 $k 는 hook 경로나 하위 명령을 바꾼다" ;; esac
}

cargs() {
  # 값을 받는 긴 옵션은 정확한 이름만 다음 낱말을 건너뛴다 → 모르는 옵션을 값으로 오인해 뒤의 -n 을 놓치지 않는다.
  want=""; end=""
  for a in "$@"; do
    if [ -n "$want" ]; then
      want=""
      case $a in *"$xu"*) deny "git commit 의 값 $a 는 따옴표 밖 확장이라 쪼개질 수 있음 → \"…\" 로 감싼다" ;; esac
      continue
    fi
    [ -z "$end" ] || continue
    case $a in
      *"$xu"*) deny "git commit 의 $a 는 따옴표 밖 확장이라 쪼개지거나 옵션이 될 수 있음 → \"…\" 로 감싸거나 -- 뒤에 둔다" ;;
      *"$xq"*) xarg "$a" ;;
      --) end=1 ;;
      --no-veri*) case --no-verify in "$a"*) deny "git commit 의 $a 는 pre-commit 을 건너뛴다" ;; esac ;;
      --message|--file|--template|--reuse-message|--reedit-message|--fixup|--squash|--author|--date|--cleanup|--trailer|--pathspec-from-file) want=1 ;;
      --*) ;;
      -?*) short "$a" ;;
    esac
  done
}

while IFS= read -r line; do
  old=$IFS; IFS=$us; set -f; set -- $line; set +f; IFS=$old
  [ "${1-}" = S ] || continue; shift
  unwrap "$@"
  # env -S 문자열은 env 가 이스케이프·변수를 펼쳐 명령을 정한다 → 글자로 판정할 수 없어 내용과 무관하게 막는다.
  if [ -n "$wrapped" ]; then
    i=0
    for a in "$@"; do
      [ "$i" -lt "$drop" ] || break; i=$((i + 1))
      case $a in -S*|-[!-]*S*|--sp*) deny "감싼 명령의 $a 는 명령 문자열을 해석하지 않음" ;; esac
    done
  fi
  shift "$drop"
  [ $# -gt 0 ] || continue
  # 감싸는 명령의 옵션은 해석하지 않는다 → 그 값(env -u X, time -o f)이 명령 자리에 남아 git 을 가리면 남은 낱말로 막는다.
  case ${1##*/} in
    git|git.exe) shift ;;
    *)
      if [ -n "$wrapped" ]; then
        for a in "$@"; do
          case $a in git|*/git|git.exe|*/git.exe) deny "감싼 명령 안의 git 을 해석하지 못함 ($a)" ;; esac
        done
      fi
      case $1 in
        *"$xu"*|*"$xq"*)
          for a in "$@"; do
            case $a in commit|config) deny "명령 이름 $1 는 실행할 때 정해짐 (뒤에 $a)" ;; esac
          done ;;
      esac
      continue ;;
  esac
  # Windows 의 git 은 환경변수 이름의 대소문자를 가리지 않는다 → deny 의 글자 규칙을 지난다.
  ev=$(printf '%s' "$envs" | LC_ALL=C tr '[:lower:]' '[:upper:]')
  case $ev in *" GIT_CONFIG"*) deny "환경변수 GIT_CONFIG* 는 hook 경로나 하위 명령을 바꾼다" ;; esac
  sub=""; alt=""; unk=""
  while [ $# -gt 0 ]; do
    # 확장 낱말은 펼친 뒤 어떤 옵션이 될지, 값 자리의 따옴표 밖 확장은 몇 낱말이 될지 모른다 → 모르는 옵션으로 본다.
    case $1 in *"$xu"*|*"$xq"*) unk=$1; break ;; esac
    case $1 in -C|--namespace|--attr-source|--git-dir|--work-tree) case ${2-} in *"$xu"*) unk=$2; break ;; esac ;; esac
    case $1 in
      -c|--config-env) [ $# -ge 2 ] || break; cfg "$2"; shift 2 ;;
      --config-env=*) cfg "${1#--config-env=}"; shift ;;
      -c*) cfg "${1#-c}"; shift ;;
      --git-dir|--work-tree) alt=$1; shift; [ $# -gt 0 ] && shift ;;
      --git-dir=*|--work-tree=*) alt=${1%%=*}; shift ;;
      -C|--namespace|--attr-source) shift; [ $# -gt 0 ] && shift ;;
      --namespace=*|--attr-source=*|--exec-path=*|--list-cmds=*) shift ;;
      -v|--version|-h|--help|--exec-path|--html-path|--man-path|--info-path) shift ;;
      -p|--paginate|-P|--no-pager|--bare|--no-replace-objects|--no-lazy-fetch|--no-optional-locks|--no-advice) shift ;;
      --literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs) shift ;;
      -*) unk=$1; break ;;
      *) sub=$1; shift; break ;;
    esac
  done
  # 모르는 옵션은 값을 받는지 알 수 없어 하위 명령 자리를 확정할 수 없다 → 그 뒤 낱말 어디에든 막을 대상이 있으면 막는다.
  if [ -n "$unk" ]; then
    # 전역 옵션·하위 명령 자리의 따옴표 밖 확장은 -c 설정과 commit 으로 쪼개질 수 있다.
    [ "$unk" != "$1" ] || case $unk in *"$xu"*) deny "git 의 $unk 는 따옴표 밖 확장이라 전역 옵션이나 하위 명령이 될 수 있음 → \"…\" 로 감싼다" ;; esac
    for a in "$@"; do
      case $a in commit|config|-c*|--config-env*) deny "git 전역 옵션 $unk 를 해석하지 못함 (뒤에 $a)" ;; esac
    done
    # 따옴표 안 확장은 한 낱말이라 하위 명령 commit 일 수 있다 → 뒤 낱말을 commit 인자로 읽는다.
    if [ "$unk" = "$1" ]; then case $unk in *"$xq"*) shift; cargs "$@" ;; esac; fi
    continue
  fi
  # 설정 이름은 대소문자를 가리지 않는다 → deny 의 철자 규칙을 지나 같은 명령 안에서 hook 경로를 바꾸고 커밋할 수 있다.
  if [ "$sub" = config ]; then for a in "$@"; do cfg "$a"; done; continue; fi
  [ "$sub" = commit ] || continue
  [ -z "$alt" ] || deny "git commit 의 $alt 는 다른 저장소의 hook 설정으로 커밋한다"
  case $ev in *" GIT_DIR "*|*" GIT_WORK_TREE "*|*" GIT_COMMON_DIR "*) deny "git commit 앞의 GIT_DIR·GIT_WORK_TREE·GIT_COMMON_DIR 는 다른 저장소의 hook 설정으로 커밋한다" ;; esac
  cargs "$@"
done <<EOS
$segs
EOS
exit 0
