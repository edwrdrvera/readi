import { cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const src = join(root, 'node_modules', 'pdfjs-dist')
const dest = join(root, 'public', 'pdfjs')
rmSync(dest, { recursive: true, force: true })
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) cpSync(join(src, dir), join(dest, dir), { recursive: true })
