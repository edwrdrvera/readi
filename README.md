# Readi

A local macOS reader for DRM-free EPUB and PDF files, with full-text search, highlights, notes, and bookmarks, built with Tauri 2, React, foliate-js, and PDF.js. It makes no network requests and needs no account.

## Run

Prerequisites: Xcode Command Line Tools, Node 26, pnpm 12, and Rust stable.

Rust comes from Homebrew's `rustup`, which does not put `cargo` on `PATH`. Add it before building:

```bash
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
```

```bash
pnpm install
pnpm tauri dev
```

To build the packaged app and a DMG:

```bash
pnpm tauri build --bundles app,dmg
```

## Test

```bash
pnpm test
cd src-tauri && cargo test
pnpm fixtures && node scripts/packaged-check.mjs
```

Current status, decisions, and open issues are in [docs/M1.md](docs/M1.md), [docs/M2.md](docs/M2.md), [docs/M3.md](docs/M3.md), and [docs/M4.md](docs/M4.md). The packaged check needs the display on, the screen unlocked, and the app's window visible (not behind another Space or a full-screen app). Set `READI_ONLY_M3=1` to run only the library and file-lifecycle phases, or `READI_ONLY_M4=1` to run only the search and annotation phases.

Search latency on a synthetic 100-book, 10-million-word corpus:

```bash
cd src-tauri && cargo test --release -- --ignored --nocapture search_perf
```
