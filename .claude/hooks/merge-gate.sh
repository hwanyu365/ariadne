#!/bin/sh
# 모든 Bash 명령 직전 hook: gh pr merge 이면 CI 통과, 현재 head 의 리뷰 요약, 그 요약의 Blocking 0건을 확인하고 아니면 exit 2 로 막는다.
# 셸 예약어와 env·timeout 같은 감싸기는 벗기고 읽는다. gh 는 merge 글자가 보이면 gh pr merge 이거나 허용 하위 명령(ALLOW)이어야 하고, 그 밖의 명령(허용 명령 제외)은 낱말 merge 또는 gh…merge 가 보이면 막는다.
# --parse: 판정 없이 stdin 에서 해석한 "PR번호 match-head-commit" 또는 none 만 출력한다 (자체 검사용).
deny() { echo "merge 차단: $*" >&2; exit 2; }
pass() { [ "$mode" = --parse ] && echo none; exit 0; }
mode=${1-}
here=$(cd "$(dirname "$0")" && pwd)
. "$here/hook-lib.sh"
# 해석 실패는 gh 글자가 보일 때 막는다 → merge 글자를 쪼갠 명령 치환도 막는다.
load gh

found=""; margs=""; ghexp=""
while IFS= read -r line; do
  old=$IFS; IFS=$us; set -f; set -- $line; set +f; IFS=$old
  [ "${1-}" = S ] || continue; shift
  unwrap "$@"; shift "$drop"
  [ $# -gt 0 ] || continue
  name=${1##*/}; shift
  case $name in
    export|declare|typeset|readonly|local)
      for a in "$@"; do case $a in GH_REPO*|GH_HOST*) ghexp=1 ;; esac; done ;;
    gh|gh.exe)
      # 하위 명령 자리의 확장은 펼친 뒤 무엇이 될지 모른다 → merge 글자를 쪼갠 경우까지 막는다.
      case "${1-} ${2-}" in *'$'*|*'`'*) deny "gh 하위 명령 자리의 확장은 해석하지 않음" ;; esac
      if [ "${1-}" = pr ] && [ "${2-}" = merge ]; then
        case "$envs" in *" GH_REPO "*|*" GH_HOST "*) deny "GH_REPO·GH_HOST 를 붙인 merge 는 다른 저장소일 수 있음" ;; esac
        [ -z "$ghexp" ] || deny "앞에서 GH_REPO·GH_HOST 를 export 한 뒤의 merge 는 다른 저장소일 수 있음"
        [ -z "$found" ] || deny "한 명령에 gh pr merge 가 둘 이상임"
        shift 2; found=1; margs=""
        for a in "$@"; do margs="$margs$a$us"; done
      else
        # ALLOW: merge 하지 않는 gh 조회 하위 명령. 그 밖(gh api 등)은 merge 글자가 보이면 막는다.
        case "${1-} ${2-}" in
          "pr view"|"pr list"|"pr checks"|"pr status"|"pr diff"|"pr comment"|"pr create"|"pr edit"|"pr ready"|"issue view"|"issue list"|"issue comment"|"issue create"|"issue edit"|"issue close"|"run view"|"run list"|"run watch"|"search prs"|"search issues") ;;
          *) for a in "$@"; do case $a in *merge*) deny "gh pr merge 형태가 아닌 gh 의 merge 는 해석하지 않음" ;; esac; done ;;
        esac
      fi ;;
    # ALLOW: PR 을 merge 하지 않는 명령
    git|git.exe|echo|printf|grep|egrep|fgrep|rg|cat|head|tail|ls|wc|test|'['|true|false|:) ;;
    *)
      for a in "$name" "$@"; do
        case $a in merge) deny "$name 안의 merge 는 해석하지 않음" ;; *gh*merge*) deny "$name 안의 gh merge 는 해석하지 않음" ;; esac
      done ;;
  esac
done <<EOS
$segs
EOS
[ -n "$found" ] || pass

# 인자는 찾은 단순 명령의 낱말에서 읽는다 → 주석·따옴표 안의 같은 글자가 대상이 되지 않는다.
n=""; mh=""; skip=""; want=""; sq=""
old=$IFS; IFS=$us; set -f; set -- $margs; set +f; IFS=$old
for a in "$@"; do
  if [ -n "$skip" ]; then skip=""; continue; fi
  if [ -n "$want" ]; then mh=$a; want=""; continue; fi
  case "$a" in
    --match-head-commit) want=1 ;;
    --match-head-commit=*) mh=${a#*=} ;;
    -R|--repo|-R*|--repo=*) deny "다른 저장소의 PR 은 검사하지 않음" ;;
    -t|--subject|-b|--body|-F|--body-file|-A|--author-email) skip=1 ;;
    --subject=*|--body=*|--body-file=*|--author-email=*) ;;
    -s|--squash) sq=1 ;;
    -d|--delete-branch) ;;
    # 허용 목록 밖의 플래그는 판정을 무르거나(--admin 은 브랜치 보호를 건너뜀) 판정과 merge 시점을 떼어 놓는다(--auto)
    -*) deny "허용하지 않는 gh pr merge 플래그: $a (허용: -s -d --match-head-commit -t -b -F -A)" ;;
    *)
      [ -z "$n" ] || deny "대상 PR 이 둘 이상임: $n $a"
      case "$a" in
        *[!0-9]*) n=$(printf '%s' "$a" | sed -n 's#^https://[^ ]*/pull/\([0-9][0-9]*\).*#\1#p'); [ -n "$n" ] || deny "대상 PR 을 해석하지 못함: $a" ;;
        *) n=$a ;;
      esac ;;
  esac
done
[ -n "$sq" ] || deny "squash 가 아닌 merge (--squash 를 붙인다)"
[ "$mode" = --parse ] && { echo "${n:--} ${mh:--}"; exit 0; }

cd "$(git rev-parse --show-toplevel)" || deny "git 저장소가 아님"
# 번호가 없으면 gh 처럼 현재 브랜치의 PR 이 대상이다.
pr=$(gh pr view $n --json number,headRefOid -q '"\(.number) \(.headRefOid)"') || deny "PR 을 조회하지 못함"
n=${pr% *}; sha=${pr#* }
# 검사한 head 와 merge 되는 head 를 묶는다 → 검사 뒤 끼어든 push 는 gh 가 거부한다.
case "$sha" in "$mh"*) [ ${#mh} -ge 7 ] || deny "--match-head-commit $sha 를 붙인다" ;; *) deny "--match-head-commit $sha 를 붙인다" ;; esac

gh pr checks "$n" >/dev/null 2>&1 || deny "CI 가 통과하지 않았거나 진행 중 (gh pr checks $n)"

# github 리뷰는 Claude App 이, local 리뷰는 세션의 gh 계정이 쓴 요약만 인정한다 → 같은 양식을 다른 계정이 남겨도 통과하지 않는다.
if [ -f .github/workflows/claude-review.yml ]; then
  who='.user.type == "Bot" and .performed_via_github_app.slug == "claude"'
else
  me=$(gh api user -q .login) && [ -n "$me" ] || deny "gh 계정을 조회하지 못함"
  who=".user.login == \"$me\""
fi
# Blocking 절이 여럿이면(코드블록에 양식을 인용한 경우 등) 모두 본다.
q='.[] | select(WHO) | .body | select(startswith("HEAD: SHA")) | split("\n## ") | map(select(startswith("🔴 Blocking")))
  | if length == 0 then "format" elif any(.[]; test("\\[B[0-9]+\\]")) then "blocking" else "ok" end'
q=$(printf '%s' "$q" | sed "s/WHO/$who/; s/SHA/$sha/")
v=$(gh api "repos/{owner}/{repo}/issues/$n/comments" --paginate --jq "$q") || deny "PR 코멘트를 조회하지 못함"
v=$(printf '%s\n' "$v" | tail -n 1)
case "$v" in
  ok) exit 0 ;;
  blocking) deny "현재 head 리뷰 요약에 Blocking 항목이 남아 있음" ;;
  format) deny "현재 head 리뷰 요약에 Blocking 절이 없음" ;;
  *) deny "현재 head($sha) 의 리뷰 요약이 없음" ;;
esac
