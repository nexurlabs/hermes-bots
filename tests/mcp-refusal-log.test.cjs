// A refused tool-server request says which route it went to and why, and never carries the token.
const test = require('node:test')
const assert = require('node:assert/strict')

const localComputer = require('../electron/local-computer.cjs')

test('a refused request names its route and reason, and the log never carries a token', async t => {
  const lines = []
  const { port, token } = await localComputer.startServer({ onLog: (...parts) => lines.push(parts.join(' ')) })
  t.after(() => localComputer.stopServer())

  const post = (path, bearer) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    })

  assert.equal((await post('/mcp', null)).status, 401)
  assert.equal((await post('/mcp', 'an-old-token')).status, 401)
  assert.equal((await post('/groups/x-manager', token)).status, 401)

  assert.ok(lines.includes('mcp request refused on the This PC route: no bearer was sent'), lines.join('\n'))
  assert.ok(
    lines.includes('mcp request refused on the This PC route: a token this app does not issue for this route (an old registration?)'),
    lines.join('\n')
  )
  assert.ok(
    lines.includes("mcp request refused on the x-manager groups route: this PC's own token was sent to a groups route"),
    lines.join('\n')
  )
  assert.ok(lines.every(line => !line.includes(token)), 'a log line carries the token')
})
