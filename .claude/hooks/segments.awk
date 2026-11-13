# PreToolUse hook 입력 JSON 에서 tool_input.command 와 cwd 를 꺼내 셸 명령을 단순 명령 단위로 나눈다.
# 출력(필드 구분 \037): "C cwd" 한 줄, 단순 명령마다 "S 낱말...", 해석 실패면 "E 이유".
# 서브셸 (...)·$(...)·`...` 의 시작과 끝은 "P"·"Q" 줄로 알린다 → 그 안의 cd 가 밖으로 번지지 않게 읽는 쪽이 되돌린다.
# 따옴표 안은 한 낱말의 글자이고, heredoc 본문과 주석은 버린다 → 데이터 안의 글자가 명령으로 읽히지 않는다.
# $(...)·`...` 는 따옴표 안에서도 실행되므로 그 안을 별도 단순 명령으로 읽는다.
BEGIN { RS = "\001"; US = "\037" }
{ all = all $0 }

function jstr(key,    p, i, c, out) {
  if (!match(all, "\"" key "\"[ \t]*:[ \t]*\"")) return "\001"
  p = RSTART + RLENGTH; out = ""
  for (i = p; i <= length(all); i++) {
    c = substr(all, i, 1)
    if (c == "\"") return out
    if (c == "\\") {
      i++; c = substr(all, i, 1)
      if (c == "n") out = out "\n"; else if (c == "t") out = out "\t"; else if (c == "r") out = out "\r"
      else out = out c
    } else out = out c
  }
  return "\001"
}

function word_end() { if (inw) { w[nw++] = cur; cur = ""; inw = 0 } }
function seg_end(    i, line) {
  word_end()
  if (nw > 0) { line = "S"; for (i = 0; i < nw; i++) line = line US w[i]; print line }
  nw = 0
}
function fail(why) { print "E" US why; bad = 1; exit }
# $(·`·( 로 들어갈 때 바깥 단순 명령의 상태를 쌓아 두고, 닫힐 때 되돌린다.
function push(kind,    i) {
  sk[sp] = kind; sm[sp] = mode; sc[sp] = cur; si[sp] = inw; sn[sp] = nw
  for (i = 0; i < nw; i++) sw[sp, i] = w[i]
  sp++; mode = "n"; cur = ""; inw = 0; nw = 0
  print "P"
}
function pop(    i) {
  seg_end(); sp--; print "Q"
  mode = sm[sp]; cur = sc[sp]; inw = si[sp]; nw = sn[sp]
  for (i = 0; i < nw; i++) w[i] = sw[sp, i]
  # 치환 결과는 알 수 없으므로 $() 로 남긴다 → 명령 이름이나 경로 자리에 오면 모르는 값으로 읽힌다.
  if (sk[sp] != "(") { cur = cur "$()"; inw = 1 }
}
# ${...} 는 한 낱말의 글자다 → 중괄호를 명령 묶음으로 읽지 않는다.
# 그 안의 명령 치환(${X:-$(...)})은 실행될 수 있지만 따로 읽지 않으므로 해석 실패로 낸다.
function brace(    e, b) {
  e = index(substr(s, i + 2), "}"); if (e == 0) fail("${ 가 닫히지 않음")
  b = substr(s, i, e + 2)
  if (index(b, "$(") || index(b, "`")) fail("${...} 안의 명령 치환은 해석하지 않음")
  cur = cur b; inw = 1; i += e + 2
}
# heredoc 은 그 줄이 끝난 뒤 본문이 온다 → 줄바꿈에서 구분자 줄까지 건너뛴다.
function skip_heredocs(    k, line, e) {
  for (k = 0; k < nh; k++) {
    for (;;) {
      if (i > n) fail("heredoc 이 닫히지 않음")
      e = index(substr(s, i), "\n")
      if (e == 0) { line = substr(s, i); i = n + 1 } else { line = substr(s, i, e - 1); i += e }
      if (hstrip[k]) sub(/^\t+/, "", line)
      if (line == hd[k]) break
    }
  }
  nh = 0
}

END {
  if (bad) exit
  cwd = jstr("cwd"); if (cwd == "\001") cwd = ""
  if (cwd ~ /^[A-Za-z]:\\/) gsub(/\\/, "/", cwd)
  s = jstr("command"); if (s == "\001") fail("명령을 읽지 못함")
  print "C" US cwd
  n = length(s); i = 1; mode = "n"; sp = 0; nw = 0; cur = ""; inw = 0; nh = 0
  while (i <= n) {
    c = substr(s, i, 1); c2 = substr(s, i, 2)
    if (mode == "s") { if (c == "'") mode = "n"; else cur = cur c; i++; continue }
    if (mode == "d") {
      if (c == "\\") { cur = cur substr(s, i + 1, 1); i += 2; continue }
      if (c == "\"") { mode = "n"; i++; continue }
      if (c2 == "$(") { push(")"); i += 2; continue }
      if (c2 == "${") { brace(); continue }
      if (c == "`") { push("`"); i++; continue }
      cur = cur c; i++; continue
    }
    # 일반 모드
    if (c == "\\") { if (substr(s, i + 1, 1) != "\n") { cur = cur substr(s, i + 1, 1); inw = 1 }; i += 2; continue }
    if (c == "'") { mode = "s"; inw = 1; i++; continue }
    if (c == "\"") { mode = "d"; inw = 1; i++; continue }
    if (c2 == "$(") { push(")"); i += 2; continue }
    if (c2 == "${") { brace(); continue }
    if (c == "`") { if (sp > 0 && sk[sp - 1] == "`") pop(); else push("`"); i++; continue }
    if (c == "(") { seg_end(); push("("); i++; continue }
    if (c == ")" && sp > 0 && (sk[sp - 1] == ")" || sk[sp - 1] == "(")) { pop(); i++; continue }
    if (c == "#" && !inw) { while (i <= n && substr(s, i, 1) != "\n") i++; continue }
    if (substr(s, i, 2) == "<<" && substr(s, i, 3) != "<<<") {
      word_end(); i += 2; strip = 0
      if (substr(s, i, 1) == "-") { strip = 1; i++ }
      while (substr(s, i, 1) ~ /[ \t]/) i++
      d = ""
      for (;;) {
        q = substr(s, i, 1)
        if (q == "'" || q == "\"") { e = index(substr(s, i + 1), q); if (e == 0) fail("heredoc 구분자의 따옴표가 닫히지 않음"); d = d substr(s, i + 1, e - 1); i += e + 1 }
        else if (q != "" && q !~ /[ \t\n;&|<>()]/) { d = d q; i++ }
        else break
      }
      if (d == "") fail("heredoc 구분자를 읽지 못함")
      hd[nh] = d; hstrip[nh] = strip; nh++
      continue
    }
    if (c == ">" || c == "<") { word_end(); i++; if (substr(s, i, 1) == "&") i++; continue }
    if (c == "\n") { seg_end(); i++; if (nh > 0) skip_heredocs(); continue }
    if (c ~ /[;&|){}!]/) { seg_end(); i++; continue }
    if (c ~ /[ \t\r]/) { word_end(); i++; continue }
    cur = cur c; inw = 1; i++
  }
  if (mode != "n") fail("따옴표가 닫히지 않음")
  if (sp > 0) fail("명령 치환·서브셸이 닫히지 않음")
  if (nh > 0) fail("heredoc 이 닫히지 않음")
  seg_end()
}
