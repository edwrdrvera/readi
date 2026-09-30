# History split plan for feat/design-system

Goal: a reviewer reads the branch as small, ordered, semantic commits. Keep every existing commit's intent and order; split only the three that mix concerns; keep the fix commits as their own iterations.

Invariants, checked by `scripts/check-history.sh origin/main 0aaa9aa20c5517be9038976fb7598bfe5dedf1ee`:
- Every commit type-checks and passes vitest (and cargo test when it touches `src-tauri`).
- The rewritten HEAD tree is exactly `0aaa9aa20c5517be9038976fb7598bfe5dedf1ee` (today's HEAD). No code changes, only where lines land.
- Backup of the original is `backup/design-system-pre-split`.

## Target sequence

1. `feat(library): expose each book's reading percent` (BookSummary.percent: db.rs, model.rs, api.ts, the test fixtures that need the field)
2. `feat(prefs): add page width, justified text, and named line spacing` (prefs.rs, prefs.ts, prefs.test.ts, PrefsForm.tsx, migration)
3. `feat(window): overlay title bar with draggable top bars` (tauri.conf.json titleBarStyle/hiddenTitle, capability start-dragging, `--font-serif` if it belongs here or with the grid)
4. `feat(library): split the library into Library and Drawer by format` (libraryView effectiveView/hasFilters + tests, store focusBook change, LibrarySidebar nav, selftestM3 duplicate step)
5. `feat(library): design top bar with search field, theme toggle, and import` (LibraryToolbar)
6. `feat(library): continue reading card and cover grid` (Library.tsx body, BookCard)
7. `feat(library): Drawer table for PDFs` (DrawerTable, Library.tsx branch that renders it)
8. `15982ac` as is (reader adoption). Split further only if it cleanly separates into (a) toolbar + footer + paged arrows and (b) docked settings panel + EPUB page width/justify; skip if a half would not build.
9. `556529f` through `6ee52a6` unchanged.
10. `5a1d97f` unchanged.
11. `refactor(reader): remove the sidebar pin; the toolbar toggle is the one control` (store, commands, ReaderSidebar, Annotations/Search/Contents tab close calls, selftestM4)
12. `feat(reader): outline contents into front matter, chapters, and back matter` (toc.ts, toc.test.ts, ContentsTab rendering)
13. `43868c4`, `92a5c93`, `feca93f` unchanged.
14. On top, after the invariant passes: `docs(design): add the design prototype and implementation briefs` (docs/design/prototype.html, BRIEF.md, NO-MODALS.md, this file) and `chore(scripts): check every commit in a range builds and passes` (scripts/check-history.sh).

Where a split point does not build on its own, merge that pair back and say which. Messages follow the repo's conventional style with a short body saying why.
