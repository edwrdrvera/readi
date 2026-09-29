# Readi

A local macOS reader for DRM-free EPUB and PDF files, built with Tauri 2, React, foliate-js, and PDF.js. It makes no network requests and needs no account.

## Run

Prerequisites: Xcode Command Line Tools, Node 26, pnpm 12, and Rust stable.

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

Current status, decisions, and open issues are in [docs/M1.md](docs/M1.md).
