// Idle memory of the packaged app: launch with an empty library, wait 30 s in
// Library, then sum `footprint` for the app and the WebKit processes it started.
// Usage: node scripts/measure-idle-memory.mjs [path/to/Readi.app]
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const app = process.argv[2] ?? join(root, 'src-tauri/target/release/bundle/macos/Readi.app')
const webkitPids = () => new Set(
  execFileSync('pgrep', ['-f', 'com.apple.WebKit'], { encoding: 'utf8' }).split('\n').filter(Boolean),
)

const before = webkitPids()
const dataDir = mkdtempSync(join(tmpdir(), 'readi-mem-'))
const child = spawn(join(app, 'Contents/MacOS/readi'), [], { env: { ...process.env, READI_DATA_DIR: dataDir }, stdio: 'ignore' })
await new Promise(r => setTimeout(r, 30_000))
const pids = [String(child.pid), ...[...webkitPids()].filter(p => !before.has(p))]
const out = execFileSync('footprint', ['--summary', ...pids.flatMap(p => ['-p', p])], { encoding: 'utf8' })
child.kill('SIGKILL')
rmSync(dataDir, { recursive: true, force: true })
console.log(out)
