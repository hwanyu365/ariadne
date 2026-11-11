#!/bin/sh
# gh pr merge 직전 hook: CI 통과, 현재 head 의 리뷰 요약, 그 요약의 Blocking 0건을 확인하고 아니면 exit 2 로 막는다.
# --parse: 판정 없이 stdin 에서 해석한 "PR번호 match-head-commit" 만 출력한다 (자체 검사용).
deny() { echo "merge 차단: $*" >&2; exit 2; }

# stdin JSON 의 tool_input.command (JSON 이스케이프된 그대로). BSD sed 도 읽도록 ERE 로 쓴다 (BRE 의 \| 는 GNU 확장).
cmd=$(sed -nE 's/.*"command" *: *"(([^"\\]|\\.)*)".*/\1/p' | head -n 1)
[ -n "$cmd" ] || deny "명령을 읽지 못함"
# 첫 gh pr merge 뒤만 본다 → --body 안에 같은 글자가 있어도 대상이 바뀌지 않는다.
rest=${cmd#*gh pr merge}
[ "$rest" != "$cmd" ] || deny "gh pr merge 를 찾지 못함"
# 인용된 값은 한 토큰으로 접고, 다음 명령(&&, ||, ;, |, 줄바꿈)부터는 버린다.
args=$(printf '%s' "$rest" | sed -E "s/\\\\\"([^\\\\]|\\\\[^\"])*\\\\\"/Q/g; s/'[^']*'/Q/g; s/(&&|\\|\\||;|\\||\\\\n).*//; s/\\\\t/ /g")

set -f  # 토큰에 * 가 있어도 파일 이름으로 펼치지 않는다
n=""; mh=""; skip=""; want=""
for a in $args; do
  if [ -n "$skip" ]; then skip=""; continue; fi
  if [ -n "$want" ]; then mh=$a; want=""; continue; fi
  case "$a" in
    --match-head-commit) want=1 ;;
    --match-head-commit=*) mh=${a#*=} ;;
    -R|--repo|-R*|--repo=*) deny "다른 저장소의 PR 은 검사하지 않음" ;;
    -t|--subject|-b|--body|-F|--body-file|-A|--author-email) skip=1 ;;
    -*) ;;
    *)
      [ -z "$n" ] || deny "대상 PR 이 둘 이상임: $n $a"
      case "$a" in
        *[!0-9]*) n=$(printf '%s' "$a" | sed -n 's#^https://[^ ]*/pull/\([0-9][0-9]*\).*#\1#p'); [ -n "$n" ] || deny "대상 PR 을 해석하지 못함: $a" ;;
        *) n=$a ;;
      esac ;;
  esac
done
[ "${1-}" = --parse ] && { echo "${n:--} ${mh:--}"; exit 0; }

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
