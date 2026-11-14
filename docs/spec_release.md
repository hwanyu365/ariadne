# 배포 스펙

## 1. 개요

| 항목 | 값 |
| --- | --- |
| 문서명 | ariadne 배포 (UC6) |
| 작성일 / 최종 수정일 | 2026-11-14 / 2026-11-14 |
| 버전 | 1.0 |
| 기준 커밋 ID | 3c5f8cd |

- **기능명:** OS 별 실행 파일 빌드와 GitHub Release
- **목적 (Why):**
  - 개발 도구나 브라우저를 따로 설치해야 하면 개발 환경이 없는 사람은 쓰지 못한다
  - 문제가 생기는 구조: 산출물은 세 OS 러너에서 따로 만들어진다 → 일부 OS 만 실패하거나 태그와 다른 버전 파일이 올라갈 수 있다

## 2. 목표 및 범위

### In Scope

- `v*` 태그 push → 세 OS 빌드 → 모두 성공하면 GitHub Release
- 태그 없이 세 OS 빌드만 확인하는 수동 실행

### Out of Scope

- 코드 서명·공증 (`NFR#12`)
- 자동 업데이트, 설치 프로그램

## 3. 요구사항

### 3.1 사용자 스토리

- `US#1` 개발 환경이 없는 사용자로서, 설치 없이 쓰기 위해, OS 에 맞는 실행 파일 하나를 받아 실행하기를 원한다 [요구사항] → FR#1~FR#4

### 3.2 기능 요구사항

- `FR#1` 세 OS 의 설치 없는 실행 파일을 만든다 [as-built] (`NFR#12`)

  ```
  When   빌드한다
  Then   Windows x64 portable exe, macOS arm64 zip(.app), Linux x64 AppImage 가 나온다
  ```

- `FR#2` 테스트와 세 OS 빌드가 모두 성공해야 Release 를 만든다 [as-built] (`NFR#12`)

  ```
  Given  검증 명령 실패 또는 한 OS 라도 빌드 실패·산출물 없음
  Then   Release 를 만들지 않는다
  Given  수동 실행(workflow_dispatch)
  Then   Release 없이 산출물만 artifact 로 남긴다
  ```

- `FR#3` 태그와 `package.json` 버전이 다르면 Release 를 만들지 않는다 [as-built] (`NFR#12`)

  ```
  Given  태그 v1.2.0, package.json 1.1.0
  Then   release job 이 실패하고 Release 가 없다
  ```

- `FR#4` 실행 파일은 외부 브라우저 없이 수집·probe·선택기를 띄운다 [as-built] (`NFR#11`)

  ```
  Given  브라우저가 설치되지 않은 환경
  When   실행 파일로 수집한다
  Then   앱에 내장된 Chromium 으로 동작한다
  ```

### 3.3 비기능 요구사항

- 색인 공통 제약 `NFR#11`, `NFR#12` 를 따른다

## 6. 동작 로직 및 정책

### 6.1 설계 결정

| 결정 | 선택 | 기각한 대안 | 근거 |
| --- | --- | --- | --- |
| `D#1` | release job 이 세 build job 전부에 의존한다 | OS 별로 Release 에 바로 올림 | 일부 OS 만 빠진 Release 가 남지 않는다 |
| `D#2` | 코드 서명하지 않는다 | 인증서 구입·서명 | 비용 발생 → 첫 실행 경고를 README 로 안내한다 |
| `D#3` | electron-builder portable·zip·AppImage | 설치 프로그램(nsis·dmg·deb) | 설치 없이 실행한다 |

## 7. 테스트 및 검증 기준

| TC | 시나리오 | 대상 | 비고 |
| --- | --- | --- | --- |
| `TC#56` | 세 OS 산출물이 모두 만들어진다 | [FR#1, FR#2, NFR#12, D#1] | (통합 — `.github/workflows/release.yml`) 릴리스 전 workflow_dispatch 실행의 artifact 3개 확인 |
| `TC#57` | 태그와 package.json 버전이 다르면 Release 가 없다 | [FR#3, NFR#12] | (수동) 릴리스 확인 목록: 태그 전 `package.json` version 과 태그 비교 |
| `TC#58` | 각 OS 실행 파일이 브라우저 설치 없이 수집한다 | [FR#4, NFR#11, D#2, D#3] | (수동) 릴리스 확인 목록: OS 별 실행 파일로 샘플 페이지 수집, 첫 실행 경고가 README 안내와 같은지 확인 |

## 부록. 변경 이력

- GH-89: 기존 동작을 as-built 로 스펙화
