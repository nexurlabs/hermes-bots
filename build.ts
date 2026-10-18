import { cpSync, mkdirSync } from 'node:fs'

const out = './app'
mkdirSync(`${out}/renderer`, { recursive: true })

const result = await Bun.build({
  entrypoints: ['./src/app.tsx'],
  outdir: `${out}/renderer`,
  naming: 'app.js',
  format: 'iife',
  target: 'browser',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

cpSync('./static/index.html', `${out}/renderer/index.html`)
cpSync('./static/styles.css', `${out}/renderer/styles.css`)
// KaTeX is loaded on demand the first time a reply has math in it (src/lib/math.ts), so it stays out of app.js.
mkdirSync(`${out}/renderer/katex`, { recursive: true })
cpSync('./node_modules/katex/dist/katex.min.js', `${out}/renderer/katex/katex.min.js`)
cpSync('./node_modules/katex/dist/katex.min.css', `${out}/renderer/katex/katex.min.css`)
cpSync('./node_modules/katex/dist/fonts', `${out}/renderer/katex/fonts`, { recursive: true, filter: src => !/\.(ttf|woff)$/.test(src) })
// Every main-process module, by glob: a hand-written list once shipped a main.cjs whose require()
// pointed at a file that was never copied (tests/build-requires.test.cjs guards this).
for (const file of new Bun.Glob('*.cjs').scanSync({ cwd: './electron' })) {
  cpSync(`./electron/${file}`, `${out}/${file}`)
}
try {
  cpSync('./static/icon.png', `${out}/icon.png`)
} catch {}
// app/ is the packaged app directory (electron-builder `directories.app`), so its package.json carries the
// metadata the installer needs. It is derived from the root package.json so the version lives in one place.
// No dependencies are listed: the renderer is bundled and main/preload only need Electron and Node built-ins.
const root = await Bun.file('./package.json').json()
const appPkg = {
  name: root.name,
  productName: root.productName,
  version: root.version,
  description: root.description,
  author: root.author,
  homepage: root.homepage,
  license: root.license,
  main: 'main.cjs'
}
await Bun.write(`${out}/package.json`, JSON.stringify(appPkg, null, 2))
console.log('built', (await Bun.file(`${out}/renderer/app.js`).size / 1024).toFixed(0) + 'KiB')
