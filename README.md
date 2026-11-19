# ariadne

A Chrome extension that follows paginated web pages to the end and saves the body text and images to local files.

The name comes from Ariadne's thread, which let Theseus retrace his way out of the labyrinth.

- Enter selectors in the side panel next to the tab you are viewing and start → it clicks next until the end and writes each page to a file
- If you don't know a selector, find it with `요소 선택` (Pick element) or `probe`
- Also works on SPAs whose URL doesn't change, by checking that the collection target actually changes before moving on
- Pages you are already logged in to are fetched with that tab's session as-is

## Installation

1. Download `ariadne-{version}-chrome.zip` from [Releases](https://github.com/hwanyu365/ariadne/releases/latest) and extract it → keep this folder (Chrome loads the extension from here)
2. Open `chrome://extensions` in Chrome → turn on `Developer mode` in the top right
3. `Load unpacked` → select the folder from step 1 (the folder containing `manifest.json`)
4. Pin ariadne from the puzzle icon in the toolbar, then click the ariadne icon on the page you want to fetch to open the side panel

- Requires Chrome 126 or later. Not published on the Chrome Web Store
- To update, extract the new zip into the same folder and click reload (↻) on ariadne in `chrome://extensions`
- While collecting, a "started debugging this browser" banner appears above the tab → this is the connection used to drive the tab. Clicking `Cancel` on the banner stops collection
- Closing the side panel stops collection

## Usage

The extension UI is in Korean only. Each UI label below is quoted as shown, followed by its meaning in parentheses.

| Input | Description |
| --- | --- |
| URL | Address of the first page. While idle, it follows the address of the current tab → you can edit it to resume from another address |
| `수집 대상` (target) | Text mode: the body container (`#articleBody`); image mode: down to the images (`#articleBody img`) |
| `next 버튼` (next button) | The element that goes to the next page |
| `제목 (선택)` (title, optional) | Text mode only. If given, `{number}화. {title}` is added as the first line (`화` means "episode") |
| `제외 (선택)` (exclude, optional) | Text mode only. Skips ads, author's notes, comments, etc. inside the body (`.ad, .comment`). Can also be picked with `제외` in the `요소 선택` toolbar |
| `인코딩` (encoding, advanced) | Leave empty to let the browser guess. If text is garbled, specify e.g. `utf-8` → this is the case when the log shows a warning starting with `경고: 페이지는 utf-8 로 보이는데` (the page looks like utf-8) |
| `폴더` (folder) | Choose the save folder with `폴더 선택` (choose folder). The same folder is used next time. If Chrome has revoked write permission, it asks again on start |
| `접두사` (prefix) | Path inside the folder. Default `page` → `page_0001.txt`, `novel/page` → `novel/page_0001.txt` |
| `한 파일로도 합치기` (also merge into one file, advanced) | In text mode, also writes everything to a single `page_all.txt` alongside the per-page files |

- **If you don't know a selector, use `요소 선택` (Pick element)** → a toolbar appears on the current tab and the hovered element is highlighted in red. Click to see selector candidates with match counts; the one you choose goes into the input.
  - Switch between `본문` (body), `next`, `제목` (title) and `제외` (exclude) from the toolbar on the page.
  - A warning is shown if the match count isn't 1 → state classes may be mixed in and break on the next page.
  - If the toolbar covers the element you want, move it with `↕ 위치` (position). When done, click `완료` (done) on the toolbar or `중지` (stop) in the panel.
- Use `probe` to scan candidates as a list → it logs next, body and image candidates and whether iframes are present.
- `중지` (stop) during collection stops after finishing the current page. Files fetched so far are kept.
- When finished, a result summary (pages fetched, elapsed time, stop reason, save folder) appears above the log.
  - If interrupted, take `마지막으로 받은 페이지: {number}번 {address}` (last page fetched) from the log, put the address into URL and the number into `시작 번호` (start number), then start again.
  - If files already exist at the same save path, it logs a warning and overwrites them.
- Shortcuts: `Ctrl+Enter` (macOS `⌘↵`) to start, `Esc` to stop. The status bar at the bottom shows pages fetched, last file and elapsed time.
- Numeric options and encoding are under `고급 옵션` (advanced options).
- Up to the 10 most recent start URLs are kept in the URL input list.
  - Selectors are remembered per site (host) → switching to a tab on another site fills in the selectors used there.
- Inputs are kept in the extension's storage (`chrome.storage`). Uninstall the extension to clear them.
- If collection finishes while you aren't looking at the panel, a Chrome notification tells you.

## Not supported

- Handling login, CAPTCHA or payment for you; body content inside iframes
- Post-processing of fetched files (ePub conversion, merging images)
- Command-line execution
- Complying with the target site's terms of use and robots policy is the user's responsibility

## Development

This repository is developed with [ADD](https://github.com/hwanyu365/add-project). Rules are in [CLAUDE.md](CLAUDE.md), the spec is in [docs/specification.md](docs/specification.md).

```sh
npm ci
npx playwright-core install chromium   # Chromium for tests
npm run verify     # verification (same command as CI)
npm run pack       # extension zip → release/
```

- After `npm run build`, you can try the built extension (`ext/`) right away by loading the `ext` folder in `chrome://extensions`
