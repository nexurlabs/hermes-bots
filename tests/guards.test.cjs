'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const g = require('../electron/guards.cjs')

test('executables and scripts a bot sends are never opened', () => {
  for (const name of [
    'setup.exe', 'SETUP.EXE', 'run.bat', 'x.cmd', 'x.com', 'pkg.msi', 'a.ps1', 'a.psm1', 'a.vbs', 'a.vbe', 'a.js', 'a.jse',
    'a.wsf', 'a.wsh', 'a.scr', 'a.lnk', 'a.reg', 'a.hta', 'a.cpl', 'a.jar', 'a.appref-ms', 'a.msc', 'a.pif',
    'invoice.pdf.exe', 'Invoice.PDF.Exe', 'evil.exe.', 'evil.exe. . ', 'evil.exe ', 'evil.exe::$DATA', 'notes.exe.txt', 'C:\\temp\\x.bat', '/tmp/x.sh'
  ]) {
    assert.equal(g.isDangerousFile(name), true, name)
  }
})

test('documents, media and archives still open', () => {
  for (const name of ['report.pdf', 'photo.PNG', 'notes.txt', 'data.csv', 'deck.pptx', 'clip.mp4', 'bundle.zip', 'README', '.env.txt']) {
    assert.equal(g.isDangerousFile(name), false, name)
  }
})

test('http targets stay on the base origin', () => {
  assert.equal(g.targetFor('http://10.0.0.5:9119', 'api/status').url.toString(), 'http://10.0.0.5:9119/api/status')
  assert.equal(g.targetFor('10.0.0.5:9119/', 'api/status').url.origin, 'http://10.0.0.5:9119')
  assert.ok(g.targetFor('http://10.0.0.5:9119', 'http://other.example/x').error)
  assert.ok(g.targetFor('http://10.0.0.5:9119', '//other.example/x').error)
  assert.ok(g.targetFor('ftp://10.0.0.5', 'x').error)
  assert.ok(g.targetFor('', 'x').error)
})

test('only loopback, saved machines or confirmed origins are known', () => {
  const saved = [{ kind: 'remote', baseUrl: 'https://box.example.com:8443' }, { kind: 'remote', baseUrl: '192.168.1.9:9119' }, { kind: 'local' }]
  const known = url => g.isKnownTarget(new URL(url), saved)
  assert.equal(known('http://127.0.0.1:51234/api/status'), true)
  assert.equal(known('http://localhost:9119/x'), true)
  assert.equal(known('http://[::1]:9119/x'), true)
  assert.equal(known('https://box.example.com:8443/api'), true)
  assert.equal(known('http://192.168.1.9:9119/api'), true)
  assert.equal(known('http://192.168.1.9:9120/api'), false)
  assert.equal(known('http://169.254.169.254/x'), false)
  assert.equal(known('https://other.example/'), false)
  assert.equal(g.isKnownTarget(new URL('https://new.example/'), saved, new Set(['https://new.example'])), true)
})
