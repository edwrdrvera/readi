# Handoff

Living status for whoever picks this up next. Update it at the end of every session. Milestone detail lives in `docs/M1.md` to `docs/M4.md`; the requirements are in *Book Reader App — Spec v1.1* (`~/Documents/Codex/2026-09-28/revi/outputs/`).

## Current state

- `main` is at 343341c (PR #25, library shelf). M1 to M4 are merged, plus the design adoption and app icon work.
- Active branch: `feat/m5-release` (off main). Nothing pushed yet.
- A stash on the main checkout holds unexplained icon and `assets/brand/` edits (`stash@{0}`, "local icon + assets/brand changes"). They match neither `main` nor `fix/app-icon`. Ask the owner before dropping them.

## Manual checks (owed since M2)

Run on 2026-10-01 against a release build of main (343341c) with a fresh data dir. Input came from `orca computer`, which sends real macOS key and mouse events and reads the accessibility tree. The build was copied to a scratch bundle with the id `dev.readi.check`, because LaunchServices sends every launch of `dev.readi.app` to `/Applications/Readi.app` and that copy opens the real library. Rerun recipe: see "How to drive the app" below.

| Check | Result |
| --- | --- |
| ⌘O opens import | Pass. Native Open panel; picking all 6 fixtures imported them (Library 3, Drawer 3). |
| ⌘K opens the palette | Pass. Opens inline in the top search field; Escape closes it. |
| ⌘⇧F library search | Pass. Typed query returns grouped hits; Return opens the hit's page. |
| ⌘F in-book search | Pass. Opens the Search tab; clicking a hit jumps and highlights the word. |
| ⌘\ sidebar | Pass. |
| ⌘1 / ⌘2 / ⌘3 themes | Pass. Sepia seen on screen; the last key pressed is the stored per-book theme. |
| ⌘D bookmark | Pass with a bug: pressing it twice on the same page stores two identical bookmarks (issue A). ⌘D does nothing while focus is in the search field. |
| Real selection and popover | Pass in EPUB and PDF with a real double-click. The popover sits above the selection and covers the line above it. |
| Highlight colours | Pass. Pressing a colour stores the highlight, anchor state `resolved`. |
| Clicking a drawn highlight | Pass. Opens the edit card in the Annotations tab with the note field focused. |
| Note autosave | Pass. Typed text was stored about 1 s later. |
| Chrome auto-hide | Pass. Toolbar hidden 3 s after opening a book. |
| Always show controls | Pass. Toolbar stays with focus in the page. |
| Look of Library, reader, palette, popover | Looked at; consistent with the design brief. No defects seen. |
| View > Sepia menu item, Go menu items | Not checked. `orca computer` cannot open the menu bar. |
| Real Finder drag | Not checked. `orca computer` cannot drag between apps. |

Findings to fix:

- **A. Duplicate bookmarks.** ⌘D on an already bookmarked page adds a second identical bookmark, and the toolbar button always reads "Add bookmark". Expected: toggle, or no-op with a visible bookmarked state.
- **B. Search snippet accessible names drop the space before the hit.** VoiceOver would read "silverharbor". Seen in the in-book Search tab (`button page 2 Letter ship bridge silverharbor quiet salt quiet.`). On-screen text is spaced correctly.
- **C. Library search hit lands without highlight.** Opening a ⌘⇧F hit goes to the right page but does not mark the word; ⌘F hits do.
- **D. Whole-page PDF selection, seen once.** On large.pdf a drag then double-click left the whole page selected (green) with no popover and nothing stored. Not reproduced on text.pdf. Needs a real-mouse retry.
- **E. Library search snippets repeat.** Three hits on the same page show nearly identical snippets.

### How to drive the app

```bash
pnpm tauri build --bundles app
scripts/drive-app.sh launch /tmp/readi-check-data
scripts/drive-app.sh get-app-state --restore-window
scripts/drive-app.sh hotkey --key CmdOrCtrl+K
```

Keystrokes need the window focused; if `window_not_focused` comes back, pass `--restore-window` once. Element indexes come from the latest `get-app-state`. Coordinate clicks are window points (screenshot pixels / 2 on Retina). `drag` produces no text selection in the webview; use `click --click-count 2` to select a word. Prefer `click --element-index` for popover buttons.

## M5 plan (spec §11.5, release hardening)

| # | Work | Status |
| --- | --- | --- |
| 1 | Manual check pass (above) | done; findings A to E open |
| 2 | CONTRIBUTING.md, third-party notices, README refresh | done. `node scripts/notices.mjs` writes THIRD_PARTY_NOTICES.md from the shipped graph (90 npm packages, 266 crates); CI fails when it is stale. Follow-ups: 16 packages ship no license file (objc2 family, block2, dispatch2, selectors, react-remove-scroll-bar, alloc-stdlib, defmt-parser), so add their standard SPDX texts; bundle the notices inside Readi.app (Tauri `resources`) |
| 3 | Migration recovery: a failed migration preserves data and reports it | mostly done. Each step already ran in a transaction with a `vN.bak` copy first (verified: a forced failure kept 6 books and wrote `readi.v3.bak`). Added: a library from a newer schema is refused and left untouched (Rust test), and a failed open shows an error dialog instead of a silent crash. Open: the dialog sits over an empty-looking Library window; hiding the window made the dialog fail to show. Dialog appearance not seen by an agent (Orca fills the visible Space); the process waits on it and exits when it is dismissed |
| 4 | Accessibility pass: keyboard and VoiceOver flows from spec §9 | started. Search snippets now have an accessible name with spaces (finding B). The accessibility tree reaches the library, reader toolbar, sidebar tabs, highlight popover, and edit card. Real VoiceOver run still owed |
| 5 | Release workflow on version tags; unsigned developer preview label without credentials | written, never run. `.github/workflows/release.yml` builds a universal DMG and opens a draft release. The universal target and `gh release create` are unverified until the first `v*` tag |
| 6 | Strip self-test hooks from the release binary | todo |
| 7 | Performance re-measure with recorded hardware, OS, dependency versions, fixture hashes | todo |
| 8 | Signing and notarization | blocked on Apple Developer credentials |

## Future tasks (not M5 blockers)

- Real 100-book search corpus (M4 issue 2); synthetic corpus meets 500 ms by a wide margin.
- Peak extraction memory 559 to 668 MB (M4 issue 3); collect paired runs of `exp/pdf-shared-worker`.
- Bookmark anchor states stay `unknown` (M4 issue 4).
- Library search has no result limit (M4 issue 5).
- Invalid XHTML sections and PDF `/Rotate` fixtures (M4 issues 6, 7).
- Annotation delete has no confirmation or undo (M4 issue 8).
- `claim_cover_job` does not mark claimed; unreadable files skipped instead of `permission_denied` (M3 issues 5, 6).
- `PdfView.place()` records clamped scrollTop under stale layout (M2).
- macOS 13 run; Tailwind v4 needs Safari 16.4, so the minimum may have to be 13.3+.
- Hidden-window PDF checks fail with `visibilityState` hidden; run the packaged check with the display awake.

## Next steps, in order

1. Finding A (duplicate bookmarks): a `TODO(human)` sits in `addBookmark` in `src/lib/store.ts`.
2. Startup error dialog: stop the empty Library rendering behind it (for example a `startup_error` command the frontend checks before it renders).
3. Findings C, D, E from the manual checks.
4. Strip the self-test commands from release builds (M5 item 6): gate `selftest_*` behind a cargo feature that `packaged-check.mjs` builds with.
5. Real VoiceOver pass and the menu-bar checks, by hand.
6. Performance re-measure (M5 item 7), then push `feat/m5-release` and open the PR into main.

## Log

- 2026-10-01: Manual check pass (findings A to E). M5 started on `feat/m5-release`: search snippet accessible names, third-party notices and CI check, CONTRIBUTING, newer-schema refusal and startup error dialog, release workflow.
- 2026-10-01: Cleaned up the main checkout (deleted `m1-skeleton`, fast-forwarded main). Started manual checks and M5.
