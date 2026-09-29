// Generates every test fixture from code, so all fixtures are MIT-licensed
// project output. Usage: node scripts/make-fixtures.mjs [--large]
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, openSync, writeSync, closeSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const out = join(import.meta.dirname, '..', 'fixtures')
mkdirSync(out, { recursive: true })

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = buf => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// Stored (uncompressed) zip, which is valid for EPUB and keeps this dependency-free.
function zip(files) {
  const locals = [], centrals = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.from(content)
    const nameBuf = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

let seed = 42
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const words = 'the river lantern quiet harbor morning silver cartographer paper ship wind archive salt glass orchard letter bridge north evening stone map keeper island signal'.split(' ')
const sentence = () => {
  const n = 8 + Math.floor(rand() * 10)
  const w = Array.from({ length: n }, () => words[Math.floor(rand() * words.length)])
  w[0] = w[0][0].toUpperCase() + w[0].slice(1)
  return w.join(' ') + '.'
}
const paragraph = () => Array.from({ length: 5 }, sentence).join(' ')

const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`

function epub({ title, author, chapters, extraManifest = '', extraFiles = [], lang = 'en', dir = null }) {
  const manifest = chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')
  const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')
  const ppd = dir ? ` page-progression-direction="${dir}"` : ''
  const htmlAttrs = dir ? `xml:lang="${lang}" lang="${lang}" dir="${dir}"` : ''
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:readi:${title}</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>${lang}</dc:language><meta property="dcterms:modified">2026-09-28T00:00:00Z</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}${extraManifest}</manifest>
<spine${ppd}>${spine}</spine></package>`
  const nav = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"${htmlAttrs && ' ' + htmlAttrs}><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((c, i) => `<li><a href="c${i}.xhtml">${c.title}</a></li>`).join('')}</ol></nav></body></html>`
  const files = [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', container],
    ['OEBPS/content.opf', opf],
    ['OEBPS/nav.xhtml', nav],
    ...chapters.map((c, i) => [`OEBPS/c${i}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"${htmlAttrs && ' ' + htmlAttrs}><head><title>${c.title}</title>${c.head ?? ''}</head><body><h1>${c.title}</h1>${c.body}</body></html>`]),
    ...extraFiles,
  ]
  return zip(files)
}

function writePdf(path, { pages, outline, imageBytesPerPage = 0, title = 'Readi Text Fixture' }) {
  const fd = openSync(path, 'w')
  let pos = 0
  const offsets = []
  const put = s => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'); writeSync(fd, b); pos += b.length }
  const obj = (n, body) => { offsets[n] = pos; put(`${n} 0 obj\n`); put(body); put('\nendobj\n') }
  put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
  const n = pages.length
  // 1 catalog, 2 pages, 3 font, 4 outlines root, then per page: page, content, [image]
  const per = imageBytesPerPage ? 3 : 2
  const pageObj = i => 5 + i * per
  const outlineBase = 5 + n * per
  const kids = pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')
  obj(1, `<< /Type /Catalog /Pages 2 0 R${outline ? ' /Outlines 4 0 R /PageMode /UseOutlines' : ''} >>`)
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`)
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  if (outline) {
    const m = outline.length
    obj(4, `<< /Type /Outlines /First ${outlineBase} 0 R /Last ${outlineBase + m - 1} 0 R /Count ${m} >>`)
  } else obj(4, '<< /Type /Outlines /Count 0 >>')
  const side = imageBytesPerPage ? Math.floor(Math.sqrt(imageBytesPerPage / 3)) : 0
  pages.forEach((lines, i) => {
    const p = pageObj(i)
    const res = `/Font << /F1 3 0 R >>${side ? ` /XObject << /Im1 ${p + 2} 0 R >>` : ''}`
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${res} >> /Contents ${p + 1} 0 R >>`)
    const text = lines.map((l, j) => `BT /F1 ${j === 0 ? 20 : 11} Tf 72 ${720 - j * 16} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n')
    const content = (side ? 'q 468 0 0 300 72 80 cm /Im1 Do Q\n' : '') + text
    obj(p + 1, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`)
    if (side) {
      const len = side * side * 3
      offsets[p + 2] = pos
      put(`${p + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${len} >>\nstream\n`)
      const img = Buffer.alloc(len)
      for (let k = 0; k < len; k++) img[k] = (k * 31 + i * 7 + (k >> 9)) & 0xff
      put(img)
      put('\nendstream\nendobj\n')
    }
  })
  if (outline) {
    outline.forEach(({ title, page }, k) => {
      const prev = k > 0 ? ` /Prev ${outlineBase + k - 1} 0 R` : ''
      const next = k < outline.length - 1 ? ` /Next ${outlineBase + k + 1} 0 R` : ''
      obj(outlineBase + k, `<< /Title (${title}) /Parent 4 0 R /Dest [${pageObj(page)} 0 R /XYZ 0 792 0]${prev}${next} >>`)
    })
  }
  const count = offsets.length
  const xref = pos
  put(`xref\n0 ${count}\n0000000000 65535 f \n`)
  for (let k = 1; k < count; k++) put(`${String(offsets[k]).padStart(10, '0')} 00000 n \n`)
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info << /Title (${title}) /Author (Readi Project) >> >>\nstartxref\n${xref}\n%%EOF\n`)
  closeSync(fd)
}

const chapters = Array.from({ length: 12 }, (_, i) => ({
  title: `Chapter ${i + 1}`,
  body: Array.from({ length: 30 }, () => `<p>${paragraph()}</p>`).join('') + (i === 6 ? '<p>The needle word is zephyrquill.</p>' : ''),
}))
writeFileSync(join(out, 'typical.epub'), epub({ title: 'The Cartographer Fixture', author: 'Readi Project', chapters }))

const canary = "http://127.0.0.1:47831"
const pwn = tag => `parent.document.body.dataset.pwned='${tag}'`
const attacks = [
  ["inline-script", "", `<script>${pwn("inline-script")};try{parent.__TAURI_INTERNALS__.invoke("selftest_report",{report:{pwned:true}})}catch(e){}</script>`],
  ["external-script", '<script src="evil.js"></script>', ""],
  ["remote-image", "", `<img src="${canary}/remote.png" onerror="${pwn("onerror")}" alt="remote"/><img src="file:///etc/hosts" alt="local"/>`],
  ["remote-css", `<link rel="stylesheet" href="${canary}/remote.css"/><style>@import url("${canary}/import.css"); @font-face { font-family: X; src: url("${canary}/f.woff2") } body { font-family: X }</style>`, ""],
  ["links", "", `<p><a href="javascript:${pwn("js-link")}">javascript link</a> <a href="file:///etc/passwd">file link</a> <a href="${canary}/">web link</a></p>`],
  ["nested-frame", "", `<iframe src="${canary}/frame"></iframe>`],
]
// One attack per chapter, so a vector that breaks rendering is identifiable.
writeFileSync(join(out, "hostile.epub"), epub({
  title: "Hostile Fixture", author: "Readi Project",
  chapters: attacks.map(([title, head, body]) => ({ title, head, body: body + `<p>${paragraph()}</p>` })),
  extraManifest: '<item id="evil" href="evil.js" media-type="application/javascript"/>',
  extraFiles: [["OEBPS/evil.js", pwn("external-script")]],
}))

const textPages = Array.from({ length: 40 }, (_, i) => [`Section ${Math.floor(i / 10) + 1}, page ${i + 1}`, ...Array.from({ length: 30 }, sentence)])
writePdf(join(out, 'text.pdf'), { pages: textPages, outline: [0, 10, 20, 30].map((p, k) => ({ title: `Section ${k + 1}`, page: p })) })

if (process.argv.includes('--large')) {
  const pages = Array.from({ length: 600 }, (_, i) => [`Large fixture page ${i + 1}`, sentence()])
  writePdf(join(out, 'large.pdf'), { pages, imageBytesPerPage: 440_000, title: 'Readi Large Fixture' })
}

// Its own seed, so adding this fixture leaves the others byte-identical.
seed = 7
const hebrew = 'הנהר פנס שקט נמל בוקר כסף מפה נייר ספינה רוח ארכיון מלח זכוכית פרדס מכתב גשר צפון ערב אבן שומר אי אות'.split(' ')
const hebrewSentence = () => Array.from({ length: 8 + Math.floor(rand() * 10) }, () => hebrew[Math.floor(rand() * hebrew.length)]).join(' ') + '.'
const rtlChapters = Array.from({ length: 6 }, (_, i) => ({
  title: `פרק ${i + 1}`,
  body: Array.from({ length: 25 }, () => `<p>${Array.from({ length: 5 }, hebrewSentence).join(' ')}</p>`).join(''),
}))
writeFileSync(join(out, 'rtl.epub'), epub({ title: 'ספר המפות', author: 'Readi Project', chapters: rtlChapters, lang: 'he', dir: 'rtl' }))

const manifest = {}
// large.pdf is listed whenever it exists, so a run without --large keeps its entry.
for (const f of ['typical.epub', 'hostile.epub', 'rtl.epub', 'text.pdf', 'large.pdf'].filter(f => existsSync(join(out, f)))) {
  const p = join(out, f)
  manifest[f] = { bytes: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') }
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ license: 'MIT, generated by scripts/make-fixtures.mjs', files: manifest }, null, 2) + '\n')
console.log(manifest)
