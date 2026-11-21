#!/bin/sh
# 모든 Bash 명령 직전 hook: gh pr merge·gh stack merge 이면 merge 될 PR 마다 CI 통과, 현재 head 의 리뷰 요약, 그 요약의 Blocking 0건을 확인하고 아니면 exit 2 로 막는다.
# 셸 예약어와 env·timeout 같은 감싸기는 벗기고 읽는다. gh 는 merge 글자가 보이면 gh pr merge·gh stack merge 이거나 허용 하위 명령(ALLOW)이어야 하고, 그 밖의 명령(허용 명령 제외)은 낱말 merge 또는 gh…merge 가 보이면 막는다.
# --parse: 판정 없이 stdin 에서 해석한 "PR번호 match-head-commit", "stack 번호" 또는 none 만 출력한다 (자체 검사용).
deny() { echo "merge 차단: $*" | tr -d '\002\003' >&2; exit 2; }
pass() { [ "$mode" = --parse ] && echo none; exit 0; }
mode=${1-}
here=$(cd "$(dirname "$0")" && pwd)
. "$here/hook-lib.sh"
# 해석 실패는 gh 글자가 보일 때 막는다 → merge 글자를 쪼갠 명령 치환도 막는다.
load gh
xu=$(printf '\002'); xq=$(printf '\003')

found=""; kind=""; margs=""; ghexp=""
while IFS= read -r line; do
  old=$IFS; IFS=$us; set -f; set -- $line; set +f; IFS=$old
  [ "${1-}" = S ] || continue; shift
  unwrap "$@"; shift "$drop"
  [ $# -gt 0 ] || continue
  name=${1##*/}; shift
  case $name in
    export|declare|typeset|readonly|local)
      for a in "$@"; do case $a in GH_REPO*|GH_HOST*|*"$xu"*|*"$xq"*) ghexp=1 ;; esac; done ;;
    gh|gh.exe)
      # 하위 명령 자리의 확장은 펼친 뒤 무엇이 될지 모른다 → merge 글자를 쪼갠 경우까지 막는다.
      # gh api 의 경로는 둘째 자리라 질의 문자열의 ? 가 glob 으로 표시된다 → glob·brace 는 pr 의 하위 명령 자리에서만 본다.
      case "${1-} ${2-}" in *'$'*|*'`'*) deny "gh 하위 명령 자리의 확장은 해석하지 않음" ;; esac
      case "${1-}" in *"$xu"*|*"$xq"*) deny "gh 하위 명령 자리의 확장은 해석하지 않음" ;; esac
      case "${1-}" in pr|stack) case "${2-}" in *"$xu"*|*"$xq"*) deny "gh 하위 명령 자리의 확장은 해석하지 않음" ;; esac ;; esac
      if { [ "${1-}" = pr ] || [ "${1-}" = stack ]; } && [ "${2-}" = merge ]; then
        case "$envs" in *" GH_REPO "*|*" GH_HOST "*) deny "GH_REPO·GH_HOST 를 붙인 merge 는 다른 저장소일 수 있음" ;; esac
        [ -z "$ghexp" ] || deny "앞에서 GH_REPO·GH_HOST 나 확장 낱말을 export 한 뒤의 merge 는 다른 저장소일 수 있음"
        [ -z "$found" ] || deny "한 명령에 merge 가 둘 이상임"
        kind=$1; shift 2; found=1; margs=""
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

# 스택은 아래 PR 부터 대상까지 함께 merge 된다 → 대상은 판정에서 GitHub 으로 정하고, 여기서는 번호 하나와 squash 만 받는다.
if [ "$kind" = stack ]; then
  n=""; sq=""; want=""
  old=$IFS; IFS=$us; set -f; set -- $margs; set +f; IFS=$old
  for a in "$@"; do
    case $a in *"$xu"*|*"$xq"*) deny "gh stack merge 인자 $a 는 확장이라 펼친 뒤를 알 수 없음 → 번호를 그대로 쓴다" ;; esac
    if [ -n "$want" ]; then [ "$a" = squash ] || deny "squash 가 아닌 merge (--merge-method $a)"; sq=1; want=""; continue; fi
    case "$a" in
      --squash|--merge-method=squash) sq=1 ;;
      --merge-method) want=1 ;;
      -y|--yes) ;;
      -*) deny "허용하지 않는 gh stack merge 플래그: $a (허용: --squash --merge-method squash -y --yes)" ;;
      *)
        [ -z "$n" ] || deny "대상이 둘 이상임: $n $a"
        case "$a" in ''|*[!0-9]*) deny "대상 번호를 해석하지 못함: $a" ;; esac
        n=$a ;;
    esac
  done
  [ -z "$want" ] || deny "--merge-method 값이 없음"
  [ -n "$sq" ] || deny "squash 가 아닌 gh stack merge (--squash 를 붙인다)"
  # 번호가 없으면 현재 브랜치의 스택 전체가 merge 되는데 그 범위를 로컬 추적 상태 없이 정할 수 없다.
  [ -n "$n" ] || deny "번호 없는 gh stack merge 는 현재 스택 전체를 merge 함 → 대상 PR 또는 스택 번호를 붙인다"
  [ "$mode" = --parse ] && { echo "stack $n"; exit 0; }
fi

# 인자는 찾은 단순 명령의 낱말에서 읽는다 → 주석·따옴표 안의 같은 글자가 대상이 되지 않는다.
if [ "$kind" = pr ]; then
n=""; mh=""; skip=""; want=""; sq=""
old=$IFS; IFS=$us; set -f; set -- $margs; set +f; IFS=$old
for a in "$@"; do
  # 따옴표 밖 확장은 값 자리에서도 쪼개져 허용 목록 밖 플래그가 될 수 있다.
  case $a in *"$xu"*) deny "gh pr merge 인자 $a 는 따옴표 밖 확장이라 쪼개지거나 플래그가 될 수 있음 → 값은 \"…\" 로 감싸고 --match-head-commit 은 SHA 를 그대로 쓴다" ;; esac
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
fi

cd "$(git rev-parse --show-toplevel)" || deny "git 저장소가 아님"
# github 리뷰는 Claude App 이, local 리뷰는 세션의 gh 계정이 쓴 요약만 인정한다 → 같은 양식을 다른 계정이 남겨도 통과하지 않는다.
reviewers() { # Dependabot 이면 1
  who=""
  if [ -f .github/workflows/claude-review.yml ]; then
    who='.user.type == "Bot" and .performed_via_github_app.slug == "claude"'
  fi
  if [ -z "$who" ] || [ -n "${1-}" ]; then
    me=$(gh api user -q .login) && [ -n "$me" ] || deny "gh 계정을 조회하지 못함"
    who="${who:+($who) or }.user.login == \"$me\""
  fi
}
verdict() { # PR번호 head
  gh pr checks "$1" >/dev/null 2>&1 || deny "CI 가 통과하지 않았거나 진행 중 (gh pr checks $1)"
  # Blocking 절이 여럿이면(코드블록에 양식을 인용한 경우 등) 모두 본다.
  q='.[] | select(WHO) | .body | select(startswith("HEAD: SHA")) | split("\n## ") | map(select(startswith("🔴 Blocking")))
    | if length == 0 then "format" elif any(.[]; test("\\[B[0-9]+\\]")) then "blocking" else "ok" end'
  q=$(printf '%s' "$q" | sed "s/WHO/$who/; s/SHA/$2/")
  v=$(gh api "repos/{owner}/{repo}/issues/$1/comments" --paginate --jq "$q") || deny "PR $1 코멘트를 조회하지 못함"
  v=$(printf '%s\n' "$v" | tail -n 1)
  case "$v" in
    ok) ;;
    blocking) deny "PR $1 현재 head 리뷰 요약에 Blocking 항목이 남아 있음" ;;
    format) deny "PR $1 현재 head 리뷰 요약에 Blocking 절이 없음" ;;
    *) deny "PR $1 현재 head($2) 의 리뷰 요약이 없음" ;;
  esac
}

if [ "$kind" = stack ]; then
  # 스택 번호와 PR 번호는 겹치지 않는다 → PR 로 조회되면 그 PR 의 스택에서 아래부터 그 PR 까지, 아니면 스택 번호로 보고 스택 전부가 대상이다.
  info='"\(.state) \(.merged_at // "-") \(.head.sha) \(.user.login) \(.stack.number // "-") \(.stack.position // "-")"'
  if p=$(gh api "repos/{owner}/{repo}/pulls/$n" --jq "$info" 2>&1); then
    set -f; set -- $p; set +f
    [ "${5-}" != - ] || deny "PR $n 은 스택에 없음 → 스택이 아닌 PR 은 gh pr merge 로 merge 한다"
    l=$(gh api "repos/{owner}/{repo}/stacks/$5" --jq '.pull_requests[].number') || deny "스택 $5 를 조회하지 못함"
    l=$(printf '%s\n' "$l" | head -n "$6")
    # 잘라낸 목록의 맨 위가 대상이어야 순서(아래부터)와 position 이 맞는다 → 어긋나면 대상이 판정에서 빠질 수 있다.
    [ "$(printf '%s\n' "$l" | tail -n 1)" = "$n" ] || deny "스택 $5 의 순서에서 PR $n 을 찾지 못함"
  else
    l=$(gh api "repos/{owner}/{repo}/stacks/$n" --jq '.pull_requests[].number') || deny "PR·스택 $n 을 조회하지 못함 ($p)"
  fi
  [ -n "$l" ] || deny "스택 $n 의 PR 을 읽지 못함"
  reviewers
  for m in $l; do
    q=$(gh api "repos/{owner}/{repo}/pulls/$m" --jq "$info") || deny "PR $m 을 조회하지 못함"
    # 작성자 dependabot[bot] 은 glob 이다 → 펼치지 않아야 저장소의 파일 이름으로 바뀌지 않는다.
    set -f; set -- $q; set +f
    [ "$2" = - ] || continue
    [ "$1" = open ] || deny "닫힌 PR $m 이 merge 대상에 있음"
    # Dependabot 의 세션 계정 요약 예외는 단독 PR 의 커밋 검사에 묶여 있다 → 스택에서는 인정하지 않는다.
    [ "$4" != "dependabot[bot]" ] || deny "Dependabot PR $m 이 스택 merge 대상에 있음"
    verdict "$m" "$3"
  done
  exit 0
fi
# 번호가 없으면 gh 처럼 현재 브랜치의 PR 이 대상이다.
pr=$(gh pr view $n --json number,headRefOid,author -q '"\(.number) \(.headRefOid) \(.author.login)"') || deny "PR 을 조회하지 못함"
n=${pr%% *}; sha=${pr#* }; by=${sha#* }; sha=${sha%% *}
# 검사한 head 와 merge 되는 head 를 묶는다 → 검사 뒤 끼어든 push 는 gh 가 거부한다.
case "$sha" in "$mh"*) [ ${#mh} -ge 7 ] || deny "--match-head-commit $sha 를 붙인다" ;; *) deny "--match-head-commit $sha 를 붙인다" ;; esac


# Dependabot 실행에는 리뷰 secret 이 없어 Claude App 요약이 생기지 않는다 → 세션 계정 요약을 인정하는 대신, 세션이 브랜치에 더한 코드를 스스로 승인하지 못하게 커밋과 업데이트 종류를 먼저 본다.
# update-type 은 간접 의존성·보안 업데이트에서 빠진다 → 그때는 본문의 "from A to B" 의 첫 숫자 자리를 비교한다.
dq='def maj: [match("^v?([0-9]+)")] | if length == 0 then null else .[0].captures[0].string end;
.[] | if .author.login != "dependabot[bot]" then "author"
  elif .commit.verification.verified != true then "author"
  elif .committer.login != "web-flow" then "author"
  else (.commit.message | split("\n---\nupdated-dependencies:\n")) as $p
    | if ($p | length) != 2 then "version" else
      [$p[0] | scan("(?:`([^`\n]+)`|\\[([^\\]\n]+)\\]\\([^)\n]*\\)) from ([^ \n]+) to ([^ \n]+)") | {n: (.[0] // .[1]), a: .[2], b: .[3]}] as $vs
      | [$p[1] | split("\n...")[0] | split("- dependency-name: ")[1:][]
        | (split("\n")[0]) as $n | ([match("\n  update-type: ([^\n]+)")][0].captures[0].string) as $u
        | if $u then ($u == "version-update:semver-patch" or $u == "version-update:semver-minor")
          else [$vs[] | select(.n == $n)] | length > 0 and all(.[]; (.a | maj) as $x | (.b | maj) as $y
            | $x != null and $x == $y) end] as $r
      | if ($r | length) == 0 or any($r[]; . != true) then "version" else "ok" end end end'
dep=""
if [ "$by" = app/dependabot ]; then
  d=$(gh api "repos/{owner}/{repo}/pulls/$n/commits" --paginate --jq "$dq") || deny "Dependabot PR 의 커밋을 조회하지 못함"
  case "$(printf '%s\n' "$d" | sort -u | tr '\n' ' ')" in
    "ok ") dep=1 ;;
    *author*) deny "Dependabot 이 작성·서명하지 않은 커밋이 있음 → @dependabot recreate 로 다시 만든다" ;;
    *) deny "patch·minor 가 아닌 업데이트가 있거나 업데이트 종류를 읽지 못함" ;;
  esac
fi

reviewers "$dep"
verdict "$n" "$sha"
exit 0
