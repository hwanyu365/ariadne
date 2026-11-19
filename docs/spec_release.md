# 배포 스펙

## 1. 개요

| 항목 | 값 |
| --- | --- |
| 문서명 | ariadne 배포 (UC6) |
| 작성일 / 최종 수정일 | 2026-11-14 / 2026-11-19 |
| 버전 | 2.0 |
| 기준 커밋 ID | 2d09b4e |

- **기능명:** Chrome 확장 zip 빌드와 GitHub Release
- **목적 (Why):**
  - 웹 스토어 없이도 받은 zip 하나를 Chrome 에 올려 쓴다
  - 문제가 생기는 구조: 산출물은 태그 push 로 CI 가 만든다 → 테스트가 깨진 커밋이나 태그와 다른 버전 파일이 올라갈 수 있다

## 2. 목표 및 범위

### In Scope

- `v*` 태그 push → 검증 → 확장 zip → GitHub Release
- 태그 없이 zip 만 확인하는 수동 실행
- 개발자 모드로 설치하는 절차 (FR#6~FR#8)
- 릴리스 확인 목록과 문제 Release 의 롤백 절차

### Out of Scope

- Chrome 웹 스토어 등록 → 확장은 개발자 모드의 "압축해제된 확장 프로그램 로드" 로 설치한다 (`D#5`)
- 자동 업데이트
- 이미 받아 둔 zip 의 회수 → 자동 업데이트가 없어 롤백은 새로 받는 사람에게만 닿는다

## 3. 요구사항

### 3.1 사용자 스토리

- `US#2` Chrome 사용자로서, 쓰던 브라우저에서 바로 쓰기 위해, Release 의 확장 zip 하나를 받아 Chrome 에 올리기를 원한다 [요구사항] → FR#2~FR#3, FR#5~FR#8

### 3.2 기능 요구사항

- `FR#2` 테스트와 확장 zip 만들기가 모두 성공해야 Release 를 만든다 [as-built] (`NFR#12`, `D#1`)

  ```
  Given  검증 명령 실패 또는 zip 을 만들지 못함
  Then   Release 를 만들지 않는다
  Given  수동 실행(workflow_dispatch)
  Then   Release 없이 zip 만 artifact 로 남긴다
  ```

- `FR#3` 태그와 `package.json` 버전이 다르면 Release 를 만들지 않는다 [as-built] (`NFR#12`)

  ```
  Given  태그 v1.2.0, package.json 1.1.0
  Then   release job 이 실패하고 Release 가 없다
  ```

- `FR#5` 배포한 Release 에 문제가 있으면 직전 Release 로 되돌린다 [요구사항] (`D#4`)

  ```
  Given  vBAD 가 Latest 이고 직전 Release 가 vPREV
  When   롤백한다 (§6.2)
  Then   vBAD 는 draft 가 되어 공개 목록·다운로드에서 빠지고 vPREV 가 Latest 다
  And    태그 vBAD 는 남고, 고친 빌드는 다음 patch 버전 태그로 낸다
  ```

- `FR#6` 확장 zip 은 확장이 쓰는 파일만 담는다 [요구사항] (`NFR#12`, `D#5`)

  ```
  When   확장 zip 을 만든다 (npm run pack → 확장 빌드를 지우고 다시 빌드한다 → 지운 소스의 옛 스크립트가 담기지 않는다)
  Then   release/ariadne-{버전}-chrome.zip 이 나오고, 최상위에 manifest.json 이 있다
  Then   담긴 파일은 manifest·패널 문서·스타일·아이콘·타이머 Worker 와 빌드된 확장·엔진 스크립트뿐이다 (테스트·소스 맵·소스 없음)
  Given  필요한 파일이 빠졌다 (빌드하지 않음 등)
  Then   zip 을 만들지 않고 실패한다
  ```

- `FR#7` 확장 버전은 package.json 버전과 같다 [요구사항] (`NFR#12`)

  ```
  Given  ext/manifest.json version 과 package.json version 이 다르다
  Then   검증 명령과 zip 만들기가 실패한다 → 태그(FR#3)·확장 버전이 하나로 맞는다
  ```

- `FR#8` Release 의 확장 zip 을 풀어 Chrome 에 올리면 그대로 동작한다 [요구사항] (`NFR#17`, `D#5`, `D#6`)

  ```
  Given  zip 을 푼 폴더
  When   개발자 모드에서 "압축해제된 확장 프로그램 로드" 로 올린다
  Then   서비스 워커가 뜨고 사이드 패널 화면이 열리며 지금 탭에서 수집한다
  Given  Chrome 이 manifest 의 최소 버전보다 낮다
  Then   Chrome 이 설치를 거부한다
  ```

### 3.3 비기능 요구사항

- 색인 공통 제약 `NFR#12`, `NFR#17` 을 따른다

## 6. 동작 로직 및 정책

### 6.1 설계 결정

| 결정 | 선택 | 기각한 대안 | 근거 |
| --- | --- | --- | --- |
| `D#1` | release job 이 검증과 zip job 에 의존하고, 태그 push 에서만 Release 를 만든다 | zip job 이 Release 에 바로 올림 | 검증이 깨진 커밋의 zip 이 Release 에 남지 않는다 |
| `D#4` | 문제 Release 는 draft 로 내리고 직전 Release 를 Latest 로 지정, 태그는 지우지 않는다 | Release·태그 삭제 후 같은 태그로 다시 빌드 / 롤백 workflow 자동화 | draft 는 `--draft=false` 로 되돌릴 수 있다. 같은 태그를 다시 쓰면 이름이 같은 다른 zip 이 생긴다. 배포가 드물고 롤백 여부는 사람이 판단한다 |
| `D#5` | 확장은 Release zip + 개발자 모드 로드로 배포한다 | Chrome 웹 스토어 | 소유자 결정. 스토어는 등록비·심사가 든다(비용) |
| `D#6` | `minimum_chrome_version` 은 확장이 쓰는 가장 새 API(`URL.parse`)가 들어온 126 으로 둔다 | 지원하는 최신 안정판 번호 | 지원 범위는 최신 안정판이지만, 최소 버전은 설치 거부 기준이라 실제로 깨지는 경계에 둔다 → 안정판이 올라가도 manifest 를 바꾸지 않는다 |

### 6.2 릴리스 확인 목록과 롤백

- 태그 전 확인 (모두 이번 릴리스 대상 커밋에서 본다 → 하나라도 안 봤으면 태그를 만들지 않는다)
  - `TC#56`: `release.yml` 수동 실행(workflow_dispatch)의 artifact 1개 (확장 zip)
  - `TC#57`: `package.json` version 과 만들 태그가 같다
  - `TC#89`: artifact 의 확장 zip 을 README 절차대로 Chrome 에 올려 사이드 패널로 샘플 페이지 수집
  - `TC#54`·`TC#55`: 패널 수동 TC (`docs/spec_window.md` §7)
- 롤백 (`FR#5`, `D#4`)

  ```sh
  gh release edit vBAD --draft
  gh release edit vPREV --latest
  ```

  - 두 명령을 모두 실행한다 → draft 로 내리기만 하면 Latest 표시가 그 draft 에 남는다
  - 원인을 고친 뒤 다음 patch 버전으로 일반 릴리스 절차를 다시 밟는다
  - 롤백 사실은 이슈로 남긴다 → 받은 사람에게 알릴 자리가 이슈와 다음 Release 노트뿐이다

## 7. 테스트 및 검증 기준

| TC | 시나리오 | 대상 | 비고 |
| --- | --- | --- | --- |
| `TC#56` | 검증이 통과하면 확장 zip 이 만들어진다 | [FR#2, FR#8, NFR#12, D#1] | (통합 — `.github/workflows/release.yml`) 릴리스 전 workflow_dispatch 실행의 artifact 확인 |
| `TC#57` | 태그와 package.json 버전이 다르면 Release 가 없다 | [FR#3, NFR#12] | (수동) 릴리스 확인 목록: 태그 전 `package.json` version 과 태그 비교 |
| `TC#87` | 확장 zip 이 허용한 파일만 담고, 빠진 파일이 있으면 실패하며, 푼 폴더를 올린 Chromium 에서 사이드 패널 화면이 열린다 | [FR#6, FR#8, D#5] | |
| `TC#88` | manifest 와 package.json 버전이 같고, 다르면 zip 만들기가 실패한다 | [FR#7, NFR#12] | |
| `TC#89` | Release 의 확장 zip 을 README 절차대로 Chrome 에 올려 수집한다 | [FR#8, NFR#17, D#5, D#6] | (수동) 릴리스 확인 목록: 개발자 모드 Chrome 에서 zip 을 풀어 올리고 샘플 페이지 수집. 최소 버전 거부는 Chrome 의 동작이라 확인하지 않는다 |
| `TC#60` | 롤백하면 문제 Release 가 공개 목록에서 빠지고 직전 Release 가 Latest 다 | [FR#5, D#4] | (수동) 롤백할 때 `gh release list` 로 vBAD 가 Draft, vPREV 가 Latest 인지 확인 |

## 부록. 변경 이력

- GH-89: 기존 동작을 as-built 로 스펙화
- GH-94: 릴리스 확인 목록과 롤백 절차
- GH-114: Chrome 확장 zip 을 Release 에 첨부하고 개발자 모드 설치 절차 (US#2, FR#6~FR#8, D#5~D#6)
- GH-116: Electron 실행 파일 배포를 지움 (US#1, FR#1, FR#4, D#2, D#3, TC#58 삭제)
