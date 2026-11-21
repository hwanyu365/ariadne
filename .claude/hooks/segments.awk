# PreToolUse hook 입력 JSON 에서 tool_input.command 와 cwd 를 꺼내 셸 명령을 단순 명령 단위로 나눈다.
# 출력(필드 구분 \037): "C cwd" 한 줄, 단순 명령마다 "S 낱말...", 해석 실패면 "E 이유". -v needle 글자가 명령에 있으면 "H" 한 줄.
# 실행할 때 정해지는 낱말은 끝에 \002(따옴표 밖 확장: 쪼개지거나 옵션이 될 수 있음) 또는 \003(따옴표 안 확장만: 한 낱말, 값 미상)을 붙인다.
# 서브셸 (...)·$(...)·`...` 의 시작과 끝은 "P"·"Q" 줄로 알린다 → 그 안의 cd 가 밖으로 번지지 않게 읽는 쪽이 되돌린다.
# 따옴표 안은 한 낱말의 글자이고, heredoc 본문과 주석은 버린다 → 데이터 안의 글자가 명령으로 읽히지 않는다.
# $(...)·`...` 는 따옴표 안에서도 실행되므로 그 안을 별도 단순 명령으로 읽는다.
BEGIN { RS = "\001"; US = "\037"; XU = "\002"; XQ = "\003" }
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

# drop: 리다이렉션 대상 낱말은 인자가 아니므로 버린다. wq: 지금 낱말에 따옴표·escape 가 있었는지.
function word_end() { if (inw) { if (drop) drop = 0; else w[nw++] = cur (xu ? XU : xq ? XQ : ""); cur = ""; inw = 0 }; wq = 0; xu = 0; xq = 0 }
# 따옴표 없이 연산자에 붙은 숫자는 fd 번호다 → 낱말로 남기지 않는다. 따옴표·escape 로 감싼 숫자는 인자다.
function fdword() { if (inw && !wq && cur ~ /^[0-9]+$/) { cur = ""; inw = 0 } else word_end() }
# 셸은 (·{·}·! 를 명령 자리(첫 낱말 앞, 예약어 뒤)에서만 연산자로 읽는다 → 그 밖에서 끊으면 뒤의 옵션이 다른 명령으로 넘어간다.
function cmdpos(    k) {
  if (inw) return 0
  if (nw == 2 && w[0] == "function") return 1
  for (k = 0; k < nw; k++) if (w[k] !~ /^(if|then|else|elif|do|while|until|time)$/) return 0
  return 1
}
# 함수 정의 name() 의 괄호는 서브셸이 아니다 → 이름을 버리고 본문을 명령 자리에서 읽는다.
function fndef(    j, k) {
  k = nw + inw
  if (xu || xq || wq || !(k == 1 || (k == 2 && w[0] == "function"))) return 0
  for (j = i + 1; substr(s, j, 1) ~ /[ \t]/; j++) ;
  if (substr(s, j, 1) != ")") return 0
  nw = 0; cur = ""; inw = 0; i = j + 1
  return 1
}
function blank(c) { return c == "" || c ~ /[ \t\r\n]/ }
# 따옴표 밖 {…} 는 , 나 .. 가 있으면 brace 확장으로 여러 낱말이 된다.
function bracex(    j, q, d) {
  d = 0
  for (j = i + 1; j <= n; j++) {
    q = substr(s, j, 1)
    if (q ~ /[ \t\r\n;&|<>()]/) return 0
    if (q == "}") return d
    if (q == "," || substr(s, j, 2) == "..") d = 1
  }
  return 0
}
# glob 의 [ 는 같은 낱말 안에서 ] 로 닫혀야 한다.
function globx(    j, q) {
  for (j = i + 1; j <= n; j++) {
    q = substr(s, j, 1)
    if (q ~ /[ \t\r\n;&|<>()]/) return 0
    if (q == "]") return 1
  }
  return 0
}
function seg_end(    i, line) {
  word_end(); drop = 0
  if (nw > 0) { line = "S"; for (i = 0; i < nw; i++) line = line US w[i]; print line }
  nw = 0
}
function fail(why) { print "E" US why; bad = 1; exit }
# $(·`·( 로 들어갈 때 바깥 단순 명령의 상태를 쌓아 두고, 닫힐 때 되돌린다.
function push(kind,    i) {
  sk[sp] = kind; sm[sp] = mode; sc[sp] = cur; si[sp] = inw; sn[sp] = nw; sd[sp] = drop; sq[sp] = wq; su[sp] = xu; sx[sp] = xq
  for (i = 0; i < nw; i++) sw[sp, i] = w[i]
  sp++; mode = "n"; cur = ""; inw = 0; nw = 0; drop = 0; wq = 0; xu = 0; xq = 0
  print "P"
}
function pop(    i) {
  seg_end(); sp--; print "Q"
  mode = sm[sp]; cur = sc[sp]; inw = si[sp]; nw = sn[sp]; drop = sd[sp]; wq = sq[sp]; xu = su[sp]; xq = sx[sp]
  for (i = 0; i < nw; i++) w[i] = sw[sp, i]
  # 치환 결과는 알 수 없으므로 $() 로 남긴다 → 명령 이름이나 경로 자리에 오면 모르는 값으로 읽힌다.
  # 프로세스 치환의 결과는 경로 하나라 쪼개지지 않는다.
  if (sk[sp] != "(") { cur = cur "$()"; inw = 1; if (sk[sp] == "p" || mode != "n") xq = 1; else xu = 1 }
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
  # 출력은 줄 단위다 → cwd 의 줄바꿈이 H·S 줄처럼 읽히지 않게 지운다.
  gsub("[\n\r" US "]", "", cwd)
  if (cwd ~ /^[A-Za-z]:\\/) gsub(/\\/, "/", cwd)
  s = jstr("command"); if (s == "\001") fail("명령을 읽지 못함")
  print "C" US cwd
  if (needle != "" && index(s, needle)) print "H"
  n = length(s); i = 1; mode = "n"; sp = 0; nw = 0; cur = ""; inw = 0; nh = 0
  while (i <= n) {
    c = substr(s, i, 1); c2 = substr(s, i, 2)
    if (mode == "s") { if (c == "'") mode = "n"; else cur = cur c; i++; continue }
    if (mode == "d") {
      if (c == "\\") { cur = cur substr(s, i + 1, 1); i += 2; continue }
      if (c == "\"") { mode = "n"; i++; continue }
      if (c2 == "$(") { push(")"); i += 2; continue }
      if (c2 == "${") { xq = 1; brace(); continue }
      if (c == "`") { push("`"); i++; continue }
      if (c == "$" && substr(s, i + 1, 1) ~ /[A-Za-z0-9_@*#?$!-]/) xq = 1
      cur = cur c; i++; continue
    }
    # 일반 모드
    if (c == "\\") { if (substr(s, i + 1, 1) != "\n") { cur = cur substr(s, i + 1, 1); inw = 1; wq = 1 }; i += 2; continue }
    if (c == "'") { mode = "s"; inw = 1; wq = 1; i++; continue }
    if (c == "\"") { mode = "d"; inw = 1; wq = 1; i++; continue }
    if (c2 == "$(") { push(")"); i += 2; continue }
    if (c2 == "${") { xu = 1; brace(); continue }
    if (c == "`") { if (sp > 0 && sk[sp - 1] == "`") pop(); else push("`"); i++; continue }
    if (c == "$" && substr(s, i + 1, 1) ~ /[A-Za-z0-9_@*#?$!'"-]/) xu = 1
    if (c == "*" || c == "?" || (c == "[" && globx())) xu = 1
    # 프로세스 치환은 바깥 명령의 낱말 하나다 (리다이렉션 대상이면 대상).
    if (c2 == "<(" || c2 == ">(") { push("p"); i += 2; continue }
    if (c == "(" && fndef()) continue
    if (c == "(") { if (!cmdpos()) fail("명령 중간의 ( 는 해석하지 않음"); seg_end(); push("("); i++; continue }
    if (c == ")" && sp > 0 && (sk[sp - 1] == ")" || sk[sp - 1] == "(" || sk[sp - 1] == "p")) { pop(); i++; continue }
    if (c == "#" && !inw) { while (i <= n && substr(s, i, 1) != "\n") i++; continue }
    if (substr(s, i, 2) == "<<" && substr(s, i, 3) != "<<<") {
      fdword(); i += 2; strip = 0
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
    if (c2 == "&>") { word_end(); i += 2; if (substr(s, i, 1) == ">") i++; drop = 1; continue }
    if (c == ">" || c == "<") {
      fdword()
      i++; q = substr(s, i, 1)
      if (c == "<" && substr(s, i, 2) == "<<") i += 2
      else if (q == "&" || q == "|" || q == ">") i++
      drop = 1; continue
    }
    if (c == "\n") { seg_end(); i++; if (nh > 0) skip_heredocs(); continue }
    if ((c == "{" || c == "!") && cmdpos() && blank(substr(s, i + 1, 1))) { seg_end(); i++; continue }
    if (c == "}" && cmdpos() && (blank(substr(s, i + 1, 1)) || substr(s, i + 1, 1) ~ /[;&|)<>]/)) { seg_end(); i++; continue }
    if (c == "{" && bracex()) xu = 1
    if (c ~ /[;&|)]/) { seg_end(); i++; continue }
    if (c ~ /[ \t\r]/) { word_end(); i++; continue }
    cur = cur c; inw = 1; i++
  }
  if (mode != "n") fail("따옴표가 닫히지 않음")
  if (sp > 0) fail("명령 치환·서브셸이 닫히지 않음")
  if (nh > 0) fail("heredoc 이 닫히지 않음")
  seg_end()
}
