'use strict'
/**
 * Runs after `bun build.ts`. Every relative require() in the packaged app/*.cjs must resolve to a
 * file inside app/: build.ts once copied main-process modules from a hand-written list, so a new
 * module could be required by main.cjs and missing from the installer.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const appDir = path.join(__dirname, '..', '..', 'app')

test('every relative require in app/*.cjs resolves inside app/', () => {
  assert.ok(fs.existsSync(path.join(appDir, 'main.cjs')), 'run `bun build.ts` first: app/main.cjs is missing')
  const files = fs.readdirSync(appDir).filter(f => f.endsWith('.cjs'))
  const sources = fs.readdirSync(path.join(__dirname, '..', '..', 'electron')).filter(f => f.endsWith('.cjs'))
  for (const src of sources) assert.ok(files.includes(src), `electron/${src} was not copied into app/`)

  let checked = 0
  for (const file of files) {
    const text = fs.readFileSync(path.join(appDir, file), 'utf8')
    for (const match of text.matchAll(/require\(\s*(['"`])(\.{1,2}\/[^'"`]+)\1\s*\)/g)) {
      const target = path.resolve(appDir, match[2])
      assert.ok(target.startsWith(appDir + path.sep), `${file}: ${match[2]} points outside app/`)
      const found = [target, `${target}.cjs`, `${target}.js`, `${target}.json`].some(f => fs.existsSync(f) && fs.statSync(f).isFile())
      assert.ok(found, `${file}: require('${match[2]}') does not resolve to a file in app/`)
      checked++
    }
  }
  assert.ok(checked > 0, 'expected main.cjs to require local modules')
})
