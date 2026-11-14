# merge-gate.sh 가 쓰는 명령 해석 단계. 부르는 쪽이 deny·pass 를 먼저 정의한다.
us=$(printf '\037')

# stdin 을 읽어 segments.awk 로 나눈다. 해석 실패는 $1 글자가 명령에 있을 때만 막는다 → 해석기의 빈틈이 모든 명령을 막지 않게 한다.
load() {
  input=$(cat)
  # macOS awk 는 UTF-8 locale 에서 문자열 == 를 정렬 규칙으로 비교해 서로 다른 한글을 같다고 본다 → 바이트로 비교하게 C locale 로 돈다.
  segs=$(printf '%s' "$input" | LC_ALL=C awk -f "$here/segments.awk") || deny "명령 해석기를 실행하지 못함"
  e=$(printf '%s\n' "$segs" | sed -n "s/^E$us//p")
  [ -n "$e" ] || return 0
  [ "$e" = "명령을 읽지 못함" ] && deny "$e"
  case "$input" in *"$1"*) deny "$e" ;; *) pass ;; esac
}

# 단순 명령 앞의 셸 예약어, VAR=값, 실행을 감싸는 명령(env·timeout 등)과 그 옵션을 벗긴다.
# 벗길 낱말 수를 drop 에, 붙은 환경변수 이름을 envs(" A B ") 에 남긴다 → 부르는 쪽이 shift "$drop" 한다.
unwrap() {
  drop=0; envs=" "
  while [ $# -gt 0 ]; do
    case $1 in
      if|then|else|elif|do|while|until) shift; drop=$((drop + 1)); continue ;;
      [A-Za-z_]*=*) envs="$envs${1%%=*} "; shift; drop=$((drop + 1)); continue ;;
    esac
    case ${1##*/} in
      env)
        shift; drop=$((drop + 1))
        while [ $# -gt 0 ]; do
          case $1 in -*) ;; [A-Za-z_]*=*) envs="$envs${1%%=*} " ;; *) break ;; esac
          shift; drop=$((drop + 1))
        done ;;
      timeout)
        shift; drop=$((drop + 1))
        while [ $# -gt 0 ]; do
          case $1 in -k|-s|--kill-after|--signal) [ $# -ge 2 ] || break; shift 2; drop=$((drop + 2)) ;; -*) shift; drop=$((drop + 1)) ;; *) break ;; esac
        done
        [ $# -gt 0 ] && { shift; drop=$((drop + 1)); } ;;
      nice)
        shift; drop=$((drop + 1))
        case ${1-} in -n) [ $# -ge 2 ] && { shift 2; drop=$((drop + 2)); } ;; -[0-9]*|--adjustment=*) shift; drop=$((drop + 1)) ;; esac ;;
      nohup|time|command|exec|builtin)
        shift; drop=$((drop + 1))
        while [ $# -gt 0 ]; do case $1 in -*) shift; drop=$((drop + 1)) ;; *) break ;; esac; done ;;
      *) return 0 ;;
    esac
  done
}
