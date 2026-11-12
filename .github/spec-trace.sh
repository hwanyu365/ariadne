#!/bin/sh
# spec-trace.sh — 스펙(docs/) 과 테스트 코드의 TC 추적성을 기계적으로 검사한다.
# usage: spec-trace.sh [-b <base-rev>] [-- <test pathspec>...]
#   기본 테스트 범위: docs/ 와 *.md 를 뺀 저장소 전체 (추적 + 미추적). 규칙은 docs/rules_spec.md §2.3
# 출력: <등급> <코드> <파일:줄> <ID>   등급 E=실패 W=경고 M=수동확인 목록
# 종료 코드: E 가 하나라도 있으면 1
set -eu

base=""
while [ $# -gt 0 ]; do
  case "$1" in
    -b) base="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || set -- ':(exclude)docs/' ':(exclude)*.md' ':(exclude).github/spec-trace.sh'

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
specs=$(git -c core.quotePath=false ls-files --cached --others --exclude-standard -- 'docs/specification.md' 'docs/spec_*.md' | grep -v '\.example$' || true)
[ -n "$specs" ] || { echo "E NO_SPEC docs/ -"; exit 1; }
# 파일 목록은 줄 단위로만 나눈다 → 이름에 공백이 있어도 한 파일이다.
IFS='
'
set -f

# -w: 짧은 번호가 긴 번호의 앞부분에 맞지 않게. --untracked: 커밋 전 테스트도 센다.
git -c core.quotePath=false grep -n -o -w -E --untracked 'TC#[0-9]+' -- "$@" > "$tmp/hits" || true

# shellcheck disable=SC2086
# -b 가 있으면 [확인필요] 는 분기점 뒤에 추가·변경된 줄만 E 다 → 범위 밖에 원래 있던 것은 W 로 보고만 한다.
: > "$tmp/new"
if [ -n "$base" ]; then
  base=$(git merge-base "$base" HEAD)  # base 끝을 쓰면 분기 뒤 main 에 추가된 테스트가 삭제로 보인다
  for f in $specs; do
    if git cat-file -e "$base:$f" 2>/dev/null; then
      git diff -U0 --no-color "$base" -- "$f" | sed -n 's/^@@ -[0-9,]* +\([0-9]*\)\(,\([0-9]*\)\)\{0,1\} @@.*/\1 \3/p' |
        while IFS=" " read -r a c; do i=0; while [ "$i" -lt "${c:-1}" ]; do echo "$f:$((a + i))"; i=$((i + 1)); done; done
    else
      awk -v f="$f" '{ print f ":" NR }' "$f"
    fi
  done > "$tmp/new"
fi

awk -v hits="$tmp/hits" -v new="$tmp/new" -v scoped="${base:+1}" -v idx="docs/specification.md" '
function ids(s, out,   n, t, p, a, b, i) {
  n = 0
  while (match(s, /[A-Z]+#[0-9]+[a-z]?(~([A-Z]+#)?[0-9]+)?/)) {
    t = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    if (index(t, "~")) {
      p = substr(t, 1, index(t, "#")); a = substr(t, length(p) + 1); a = substr(a, 1, index(a, "~") - 1) + 0
      b = substr(t, index(t, "~") + 1); sub(/^[A-Z]+#/, "", b); b += 0
      for (i = a; i <= b; i++) out[++n] = p i
    } else out[++n] = t
  }
  return n
}
function covered(key,   p, r, m, j) {
  if (key in ref) return 1
  if (!(key in arrow)) return 0
  split(key, p, SUBSEP); m = ids(arrow[key], r)
  if (m == 0) return 0
  for (j = 1; j <= m; j++) if (!((p[1] SUBSEP r[j]) in ref)) return 0
  return 1
}
BEGIN {
  while ((getline l < new) > 0) changed[l] = 1
  while ((getline l < hits) > 0) {
    id = l; sub(/.*:/, "", id); loc = l; sub(/:[^:]*$/, "", loc)
    if (!(id in hit)) hit[id] = loc
  }
}
FNR == 1 { f = FILENAME; sec = ""; fence = 0; hdr = 0; initem = 0 }
/^```/ { fence = !fence; next }
fence { next }
/^## / {
  if (match($0, /^## [0-9]+/)) sec = substr($0, 4, RLENGTH - 3) + 0
  else if ($0 ~ /^## 부록/) sec = "A"
  else sec = "?"
  hdr = 0; initem = 0; next
}
# 정의 줄과 그 아래 들여쓴 줄은 그 항목에 속한다.
{
  isitem = ($0 ~ /^- `[A-Z]+#[0-9]/ || $0 ~ /^\|/)
  if (isitem) initem = 1
  else if ($0 ~ /^[ \t]+[^ \t]/ && initem) isitem = 1
  else if ($0 !~ /^[ \t]*$/) initem = 0
}
sec != "A" && index($0, "[확인필요]") {
  if (!isitem) print "W UNCONFIRMED_MENTION " f ":" FNR " -"
  else if (scoped && !((f ":" FNR) in changed)) print "W UNCONFIRMED_OLD " f ":" FNR " -"
  else print "E UNCONFIRMED " f ":" FNR " -"
}
# 정의 자리(§3·§4, 색인의 번호 없는 절)의 줄 머리 글머리가 형식을 어긴 ID 로 시작하면 막는다 → 정의가 검사에서 조용히 빠지지 않는다.
(sec == 3 || sec == 4 || (f == idx && sec == "?")) && $0 ~ /^(-[ \t]*|[*+][ \t]+|[0-9]+\.[ \t]*)(\*\*|\[)?`?[A-Z]+#[0-9]/ && $0 !~ /^- `[A-Z]+#[0-9]+[a-z]?`/ {
  print "E BAD_DEF " f ":" FNR " -"
}
# 정의는 줄 머리 - `ID#n` 또는 표 첫 칸뿐이다 (rules_spec §2.3). 들여쓴 줄·백틱 없는 글머리의 ID 는 참조다.
sec != 7 && sec != "A" && (match($0, /^- `[A-Z]+#[0-9]+[a-z]?`/) || match($0, /^\|[ \t]*`?[A-Z]+#[0-9]+[a-z]?`?/)) {
  t = substr($0, RSTART, RLENGTH); sub(/^[-|][ \t]*`?/, "", t); sub(/`$/, "", t)
  if (t !~ /^TC#/) {
    key = f SUBSEP t
    if (key in def) print "E DUP_ID " f ":" FNR " " t
    else { def[key] = FNR; defsec[key] = sec; order[++nd] = key }
    if (t ~ /^US#/ && (ai = index($0, "→"))) arrow[key] = substr($0, ai)
  }
}
sec == 7 && !/^\|/ { hdr = 0 }
sec == 7 && /^\|/ {
  n = split($0, c, "|")
  for (i = 2; i < n; i++) { x = c[i]; gsub(/^[ \t`]+|[ \t`]+$/, "", x); c[i] = x }
  if (!hdr) {
    ct = cd = cb = 0
    for (i = 2; i < n; i++) { if (c[i] == "TC") ct = i; if (c[i] == "대상") cd = i; if (c[i] == "비고") cb = i }
    if (ct && cd) hdr = 1
    next
  }
  if (c[ct] !~ /^TC#[0-9]+$/) next
  tc = c[ct]
  if (tc in tcdef) { print "E DUP_TC " f ":" FNR " " tc; next }
  tcdef[tc] = f ":" FNR; tcnote[tc] = cb ? c[cb] : ""
  m = ids(c[cd], r)
  if (m == 0) print "E TC_NO_TARGET " f ":" FNR " " tc
  for (j = 1; j <= m; j++) refs[++nr] = f SUBSEP r[j] SUBSEP FNR
}
END {
  # TC 대상 ID 는 같은 파일에서 먼저 찾고, 없으면 색인(공통 제약)에서 찾는다.
  for (j = 1; j <= nr; j++) {
    split(refs[j], p, SUBSEP)
    if ((p[1] SUBSEP p[2]) in def) ref[p[1] SUBSEP p[2]] = 1
    else if ((idx SUBSEP p[2]) in def) ref[idx SUBSEP p[2]] = 1
    else print "E UNDEF_REF " p[1] ":" p[3] " " p[2]
  }
  for (k = 1; k <= nd; k++) {
    key = order[k]
    split(key, p, SUBSEP)
    # 색인은 번호 없는 절(공통 제약 등)도 본다. 번호 절은 기능 스펙과 같이 §3·§4·§6 만 본다.
    if (defsec[key] != 3 && defsec[key] != 4 && defsec[key] != 6 && !(p[1] == idx && defsec[key] == "?")) continue
    if (covered(key)) continue
    print ((defsec[key] == 6 || p[2] ~ /^D#/) ? "W NO_TC " : "E NO_TC ") p[1] ":" def[key] " " p[2]
  }
  for (tc in tcdef) {
    if (tc in hit) continue
    if (tcnote[tc] ~ /\((통합|수동)/) print "M MANUAL " tcdef[tc] " " tc
    else print "E NO_TEST " tcdef[tc] " " tc
  }
  for (id in hit) if (!(id in tcdef)) print "E ORPHAN_TC " hit[id] " " id
}
' $specs > "$tmp/out"

# Red 삭제: 분기점에 있던 TC 테스트 이름이 작업 트리에서 사라졌는지. 단언 약화와 같은 PR 안에서 만들고 지운 테스트는 잡지 못한다.
# W 로만 낸다 → TC 가 스펙에 남아 테스트가 0건이면 NO_TEST 가 이미 E 이고, TC 까지 지웠으면 스펙 diff 리뷰 대상이다.
if [ -n "$base" ]; then
  name='TC#[0-9]+[^`"'"'"']*'
  git grep -h -o -E "$name" "$base" -- "$@" | sed 's/[[:space:]]*$//' | sort -u > "$tmp/b" || true
  git grep -h -o -E --untracked "$name" -- "$@" | sed 's/[[:space:]]*$//' | sort -u > "$tmp/h" || true
  comm -23 "$tmp/b" "$tmp/h" | while IFS= read -r t; do
    id=${t%% *}
    if grep -q -E "^$id([^0-9]|\$)" "$tmp/h"; then echo "W TEST_NAME_GONE $base $t"; else echo "W TEST_REMOVED $base $t"; fi
  done >> "$tmp/out"
fi

sort "$tmp/out"
# poc 는 스펙·TDD 가 선택이라 보고만 하고 실패시키지 않는다.
grep -q '^## 성숙도: `poc`' CLAUDE.md 2>/dev/null && exit 0
! grep -q '^E ' "$tmp/out"
