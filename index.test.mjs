// Tests for the comment-checker rules. Run: node --test plugins/comment-checker/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from './index.js'
import { patchPaths, truncate, MAX_REPORT_CHARS } from './index.js'

// The plugin exports only its definition, so drive it through the hooks it
// registers. That is also what OpenCode does.
async function harness() {
  let before
  let after
  const ctx = {
    tool: {
      hook: async (name, cb) => {
        if (name === 'execute.before') before = cb
        if (name === 'execute.after') after = cb
        return { dispose: async () => {} }
      },
    },
  }
  await plugin.setup(ctx)
  assert.equal(typeof before, 'function', 'execute.before must be registered')
  assert.equal(typeof after, 'function', 'execute.after must be registered')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-checker-'))
  // A write to a path that does not exist yet is a new file. Create the file
  // only after execute.before has run, the way a real write does.
  const write = async (name, content) => {
    const file = path.join(dir, name)
    await before({ tool: 'write', input: { path: file } })
    fs.writeFileSync(file, content)
    return file
  }
  const run = async (tool, input) => {
    const event = { tool, status: 'completed', input, result: { content: 'Updated file' } }
    await after(event)
    return event.result.content
  }
  const runWith = async (tool, input, result) => {
    const event = { tool, status: 'completed', input, result }
    await after(event)
    return event.result.content
  }
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
  return { write, run, runWith, cleanup }
}

test('flags a comment that restates the next line', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.ts', 'let counter = 0\n// increment counter\nincrement(counter)\n')
    const out = await h.run('write', { path: file })
    assert.match(out, /restates the line below it/)
  } finally {
    h.cleanup()
  }
})

test('leaves a why-comment alone', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.ts', 'let i = 0\n// The API counts from one, so start at zero here.\ni++\n')
    const out = await h.run('write', { path: file })
    assert.equal(out, 'Updated file')
  } finally {
    h.cleanup()
  }
})

test('@allow silences one line', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.ts', 'let counter = 0\n// increment counter @allow\nincrement(counter)\n')
    const out = await h.run('write', { path: file })
    assert.equal(out, 'Updated file')
  } finally {
    h.cleanup()
  }
})

test('comment-checker-disable-file silences the whole file', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.ts', '// comment-checker-disable-file\nlet counter = 0\n// increment counter\nincrement(counter)\n')
    const out = await h.run('write', { path: file })
    assert.equal(out, 'Updated file')
  } finally {
    h.cleanup()
  }
})

test('flags a bare TODO and accepts a well-formed one', async () => {
  const h = await harness()
  try {
    const bare = await h.write('bare.ts', '// TODO fix this later\nlet x = 1\n')
    assert.match(await h.run('write', { path: bare }), /TODO needs an owner/)

    const good = await h.write('good.ts', '// TODO(val): drop this once the v1 endpoint is gone\nlet x = 1\n')
    assert.equal(await h.run('write', { path: good }), 'Updated file')
  } finally {
    h.cleanup()
  }
})

test('flags commented-out code', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.ts', '// const total = price * qty;\nlet x = 1\n')
    assert.match(await h.run('write', { path: file }), /commented-out code/)
  } finally {
    h.cleanup()
  }
})

test('flags a decorative banner', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.ts', '// ==========\nlet x = 1\n')
    assert.match(await h.run('write', { path: file }), /decorative separator/)
  } finally {
    h.cleanup()
  }
})

test('only checks lines the tool added', async () => {
  const h = await harness()
  try {
    const original = '// increment counter\nlet counter = 0\nincrement(counter)\n'
    const file = await h.write('a.ts', original)
    // An edit that changes nothing must not blame the pre-existing comment.
    const out = await h.run('edit', { filePath: file, oldString: 'let counter = 0', newString: 'let counter = 0' })
    assert.equal(out, 'Updated file')
  } finally {
    h.cleanup()
  }
})

test('flags a comment added by an edit', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.ts', 'let counter = 0\nincrement(counter)\n')
    const edited = 'let counter = 0\n// increment counter\nincrement(counter)\n'
    fs.writeFileSync(file, edited)
    const out = await h.run('edit', {
      filePath: file,
      oldString: 'let counter = 0\nincrement(counter)',
      newString: 'let counter = 0\n// increment counter\nincrement(counter)',
    })
    assert.match(out, /restates the line below it/)
  } finally {
    h.cleanup()
  }
})

test('ignores other tools and failed calls', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.ts', 'let counter = 0\n// increment counter\nincrement(counter)\n')
    assert.equal(await h.run('read', { path: file }), 'Updated file')
  } finally {
    h.cleanup()
  }
})

test('skips an unknown syntax instead of guessing', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.xyz', '// increment counter\nincrement(counter)\n')
    assert.equal(await h.run('write', { path: file }), 'Updated file')
  } finally {
    h.cleanup()
  }
})

test('appends to an existing tool result instead of replacing it', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.ts', 'let counter = 0\n// increment counter\nincrement(counter)\n')
    const out = await h.run('write', { path: file })
    assert.match(out, /^Updated file/)
    assert.match(out, /comment-checker:/)
  } finally {
    h.cleanup()
  }
})

test('checks every file in a patch', async () => {
  const h = await harness()
  try {
    const file = await h.write('a.ts', 'let counter = 0\n// increment counter\nincrement(counter)\n')
    const patchText = `*** Add File: a.ts\n+let counter = 0\n+// increment counter\n+increment(counter)\n`
    const result = {
      content: 'Success. Updated the following files:\nA a.ts',
      output: { applied: [{ type: 'add', resource: 'a.ts', target: file }] },
    }
    const out = await h.runWith('patch', { patchText }, result)
    assert.match(out, /restates the line below it/)
  } finally {
    h.cleanup()
  }
})

test('extracts paths from patch markers', () => {
  const text = '*** Add File: /a/b.ts\n+x\n*** Update File: /c/d.ts\n+y\n*** Delete File: /e/f.ts\n'
  assert.deepEqual(patchPaths(text), ['/a/b.ts', '/c/d.ts', '/e/f.ts'])
  assert.deepEqual(patchPaths(undefined), [])
})

test('truncates a long report and says so', () => {
  const long = 'x'.repeat(MAX_REPORT_CHARS + 500)
  const out = truncate(long)
  assert.ok(out.length <= MAX_REPORT_CHARS, 'output must fit the cap')
  assert.match(out, /Truncated to \d+ characters/)
})

test('leaves a short report untouched', () => {
  assert.equal(truncate('short'), 'short')
})

test('caps the warning for a file full of bad comments', async () => {
  const h = await harness()
  try {
    const lines = []
    for (let i = 0; i < 200; i++) {
      lines.push(`// increment counter`, `increment(counter)`)
    }
    const file = await h.write('big.ts', lines.join('\n') + '\n')
    const out = await h.run('write', { path: file })
    assert.match(out, /comment-checker:/)
    assert.ok(out.length < MAX_REPORT_CHARS + 100, 'the warning must stay bounded')
  } finally {
    h.cleanup()
  }
})
