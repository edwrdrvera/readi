# Contributing to Readi

Readi is a local, offline macOS reader. Changes must keep it offline: no network requests, no telemetry, no update checks.

## Set up

Follow [README.md](README.md#run) to install the toolchain and run the app. Rust from Homebrew needs `export PATH=/opt/homebrew/opt/rustup/bin:$PATH` in every shell.

## Where things live

| Path | Contents |
| --- | --- |
| `src-tauri/src` | Rust: database and migrations (`db.rs`), import, watched folders, search, the `book://` protocol, menus |
| `src/lib` | Frontend state (`store.ts`), the typed IPC surface (`api.ts`), preferences, text mappings |
| `src/reader` | EPUB (foliate-js) and PDF (PDF.js) readers behind one handle (`handle.ts`) |
| `src/components` | Library, reader chrome, sidebars, search, annotations |
| `src/selftest*.ts` | In-app self-tests that `scripts/packaged-check.mjs` drives in the release build |
| `fixtures/` | Test books, listed with their hashes and rights in `manifest.json` |
| `docs/` | Per-milestone decisions, verified behavior, and open issues |

## Before you open a pull request

1. Run the checks CI runs:

   ```bash
   npx tsc --noEmit
   pnpm test
   cd src-tauri && cargo test
   ```

2. For changes to reading, import, search, or annotations, run the packaged check with the display on and the window visible:

   ```bash
   pnpm tauri build --bundles app
   node scripts/packaged-check.mjs
   ```

3. For keyboard, menu, or mouse behavior, drive the release build with real input. `scripts/drive-app.sh` explains how; [HANDOFF.md](HANDOFF.md) lists what has been checked.
4. If you add, remove, or upgrade a dependency, regenerate the notices: `node scripts/notices.mjs`. CI fails when they are stale.
5. If you change the database, add a migration. Never edit a released migration.

## Commits and pull requests

- Small commits, each passing the checks above. `scripts/check-history.sh <base>` verifies every commit on a branch.
- Commit subjects follow the existing style: `type(scope): imperative summary`, for example `fix(pdf): read ranges in 16 KiB chunks`.
- A pull request says what changes for the reader of the app, how it was verified, and what is still open.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
