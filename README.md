# ariadne

페이지네이션으로 이어지는 웹 페이지를 끝까지 넘기며 본문 텍스트와 이미지를 로컬 파일로 받아 두는 데스크톱 도구.

이름은 미로에서 길을 되짚게 해 준 아리아드네의 실에서 왔다.

- 창에 URL 과 셀렉터를 넣고 시작하면 next 를 끝까지 누르며 페이지마다 파일로 쓴다
- 셀렉터를 모르면 `probe` 로 후보를 먼저 찾는다
- URL 이 바뀌지 않는 SPA 도 수집 대상이 실제로 바뀌는지 보고 넘긴다

## 설치

```sh
pip install -r requirements.txt
python -m playwright install chromium
```

## 실행

```sh
python gui.py
```

| 입력 | 설명 |
| --- | --- |
| URL | 첫 페이지 주소 |
| 수집 대상 셀렉터 | 텍스트 모드는 본문 컨테이너(`#articleBody`), 이미지 모드는 이미지까지(`#articleBody img`) |
| next 버튼 셀렉터 | 다음 페이지로 가는 요소 |
| 제목 셀렉터 | 텍스트 모드에서만. 주면 첫 줄에 `{번호}화. {제목}` 을 붙인다 |
| 저장 경로 접두사 | `out/page` → `out/page_0001.txt` |

- **셀렉터를 모를 때는 URL 만 넣고 `요소 선택`** → 브라우저가 뜨고 마우스를 올린 요소가 빨갛게 표시된다. 클릭하면 셀렉터 후보가 매치 수와 함께 뜨고, 고른 것이 입력란에 들어간다.
  - 페이지 위 툴바에서 본문·next·제목을 전환한다. 브라우저는 한 번만 뜬다.
  - 매치 수가 1이 아니면 경고가 붙는다 → 상태 클래스가 섞여 다음 페이지에서 깨질 수 있다는 뜻이다.
  - 툴바가 고르려는 요소를 가리면 `위치` 로 옮긴다. 다 고르면 `완료` 또는 `중지`.
- `probe` 는 후보를 목록으로 훑어볼 때 쓴다 → next·본문·이미지 후보와 iframe 유무를 로그에 뽑아 준다. `브라우저 창 띄우기` 와 함께 쓰면 실제 화면을 보며 맞출 수 있다.
- 수집 중 `중지` 는 현재 페이지를 마친 뒤 멈춘다. 그때까지 받은 파일은 남는다.

## CLI

같은 기능을 명령줄에서 쓸 수 있다.

```sh
python scrape.py <URL> --probe                                  # 셀렉터 후보 찾기
python scrape.py <URL> -t '#articleBody' -n '.next' -o out/page  # 텍스트
python scrape.py <URL> -m image -t '#articleBody img' -n '.next' -o out/img
```

`-h` 로 전체 옵션(`--max`, `--start`, `--digits`, `--timeout`, `--delay`, `--headful`)을 본다.

## 안 되는 것

- 로그인·캡차가 필요한 페이지, iframe 안의 본문
- 받은 파일의 후처리(ePub 변환, 이미지 합치기)
- 수집 대상 사이트의 이용약관·robots 정책 준수는 사용자 책임이다

## 개발

이 저장소는 [ADD](https://github.com/hwanyu365/add-project) 로 개발한다. 규칙은 [CLAUDE.md](CLAUDE.md), 스펙은 [docs/specification.md](docs/specification.md).

```sh
python test_scrape.py
```
