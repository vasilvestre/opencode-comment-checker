// comment-checker — OpenCode v2 plugin.
//
// After an edit or write, scan the comments the tool added and report the ones
// that only restate the code. The model sees the report on the next turn and
// can fix them. This is a warning, never a block: a false positive must not
// cost the user a working edit.
//
// Escape hatches, same as oh-my-openagent:
//   // @allow                     on the offending line
//   // comment-checker-disable-file anywhere in the file
//
// Only added lines are checked. Pre-existing comments are not the agent's work.

import fs from 'node:fs'

const DISABLE_FILE = 'comment-checker-disable-file'
const ALLOW_LINE = '@allow'

// Comment syntax per extension. A file missing from this map is skipped.
const SYNTAX = {
  '.js': ['//', '/*'], '.mjs': ['//', '/*'], '.cjs': ['//', '/*'],
  '.ts': ['//', '/*'], '.tsx': ['//', '/*'], '.jsx': ['//', '/*'],
  '.go': ['//', '/*'], '.rs': ['//', '/*'], '.java': ['//', '/*'],
  '.c': ['//', '/*'], '.h': ['//', '/*'], '.cpp': ['//', '/*'],
  '.php': ['//', '/*', '#'], '.swift': ['//', '/*'], '.kt': ['//', '/*'],
  '.cs': ['//', '/*'], '.scala': ['//', '/*'],
  '.py': ['#'], '.sh': ['#'], '.bash': ['#'], '.rb': ['#'],
  '.yaml': ['#'], '.yml': ['#'], '.toml': ['#'], '.tf': ['#'],
  '.sql': ['--'], '.lua': ['--'], '.vim': ['"'],
}

// Each rule returns a reason, or null when the comment is fine.
const RULES = [
  {
    // "// increment i" above "i++"
    name: 'restates-next-line',
    test: (text, next) => {
      if (!next) return null
      const words = text.toLowerCase().split(/\W+/).filter(Boolean)
      if (words.length < 2) return null
      const code = next.toLowerCase()
      const hits = words.filter((w) => w.length > 2 && code.includes(w)).length
      if (hits >= Math.max(2, Math.ceil(words.length * 0.6))) {
        return 'restates the line below it'
      }
      return null
    },
  },
  {
    // "// helper" above "function helper()"
    name: 'restates-name',
    test: (text, next) => {
      if (!next) return null
      const decl = next.match(/(?:function|def|fn|func|class|const|let|var)\s+([A-Za-z_$][\w$]*)/)
      if (!decl) return null
      const name = decl[1].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase()
      const words = text.toLowerCase().replace(/\W+/g, ' ').trim()
      if (words && name.includes(words)) return `restates the name \`${decl[1]}\``
      return null
    },
  },
  {
    name: 'bare-todo',
    test: (text) => {
      const m = text.match(/^TODO\b(.*)$/i)
      if (!m) return null
      const rest = m[1].trim()
      // An owner is either "(name)" or "name:" at the start. Anything else is prose.
      if (!rest || !/^(\([\w.-]+\)|[\w.-]+:)/.test(rest)) {
        return 'TODO needs an owner and a reason: `TODO(name): action, reason`'
      }
      return null
    },
  },
  {
    name: 'commented-code',
    test: (text) => {
      if (/[;{}]\s*$/.test(text) && /[=(]/.test(text)) return 'commented-out code'
      if (/^\s*(if|for|while|return|const|let|var|def|function|class)\b.*[;{]?$/.test(text)) {
        return 'commented-out code'
      }
      return null
    },
  },
  {
    name: 'decorative-banner',
    test: (text) => {
      if (/^[=\-*#_~]{4,}$/.test(text.replace(/\s/g, ''))) return 'decorative separator'
      return null
    },
  },
]

function syntaxFor(filePath) {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return null
  return SYNTAX[filePath.slice(dot).toLowerCase()] ?? null
}

// Strip the comment marker and surrounding decoration, keep the prose.
function commentText(line, markers) {
  for (const marker of markers) {
    const at = line.indexOf(marker)
    if (at < 0) continue
    return line
      .slice(at + marker.length)
      .replace(/\*\/\s*$/, '')
      .replace(/^\s*\*\s?/, '')
      .trim()
  }
  return null
}

function isComment(line, markers) {
  return markers.some((m) => line.trimStart().startsWith(m))
}

function checkFile(filePath, before, after) {
  const markers = syntaxFor(filePath)
  if (!markers) return []
  if (after.includes(DISABLE_FILE)) return []

  const beforeLines = new Set(before.split('\n'))
  const lines = after.split('\n')
  const findings = []

  lines.forEach((line, i) => {
    if (beforeLines.has(line)) return
    if (!isComment(line, markers)) return
    if (line.includes(ALLOW_LINE)) return

    const text = commentText(line, markers)
    if (!text) return

    const next = lines.slice(i + 1).find((l) => l.trim() && !isComment(l, markers))
    for (const rule of RULES) {
      const reason = rule.test(text, next)
      if (reason) {
        findings.push({ line: i + 1, text: text.slice(0, 80), reason })
        return
      }
    }
  })

  return findings
}

function readOrEmpty(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

// `patch` carries every file it touches in one text blob, and reports the
// resolved absolute path per file in its result. Prefer the result: patch paths
// are relative to the workspace, which is not the server's working directory.
function patchPaths(patchText) {
  if (typeof patchText !== 'string') return []
  const paths = []
  for (const line of patchText.split('\n')) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    if (m) paths.push(m[1].trim())
  }
  return paths
}

function appliedTargets(result) {
  const applied = result?.output?.applied
  if (!Array.isArray(applied)) return []
  return applied.map((a) => a?.target).filter((t) => typeof t === 'string')
}

function report(findings, filePath) {
  const head = `comment-checker: ${findings.length} comment(s) in ${filePath} add nothing.`
  const body = findings
    .map((f) => `  line ${f.line}: ${f.reason} — "${f.text}"`)
    .join('\n')
  return [
    head,
    body,
    'Delete them, or replace each with why the code exists. Keep one only if it earns its place: add `@allow` on that line.',
  ].join('\n')
}

// A finding list grows with the file. Cap the message so a large patch cannot
// push a long session into compaction: the first findings are the useful ones.
const MAX_REPORT_CHARS = 2000

function truncate(text, max = MAX_REPORT_CHARS) {
  if (text.length <= max) return text
  const marker = `\n[Truncated to ${max} characters. Fix these first, then run the check again.]`
  const head = text.slice(0, max - marker.length).replace(/[ \t\r\n]+$/, '')
  return `${head}${marker}`
}

export { patchPaths, truncate, MAX_REPORT_CHARS }

export default {
  id: 'vasilvestre.opencode-comment-checker',
  async setup(ctx) {
    // write replaces the whole file, so the previous content is gone by the time
    // the hook runs. Fingerprint every file this plugin saw before it changed;
    // a write to an unknown file is a new file, and all of it is the agent's.
    const seen = new Map()

    await ctx.tool.hook('execute.before', (event) => {
      const input = event.input ?? {}
      const targets =
        event.tool === 'patch' ? patchPaths(input.patchText) : [input.filePath ?? input.path]
      for (const filePath of targets) {
        if (typeof filePath !== 'string') continue
        // Only an existing file has a previous state. Recording '' for a new file
        // would make every line look pre-existing and hide all findings.
        if (!fs.existsSync(filePath)) continue
        seen.set(filePath, readOrEmpty(filePath))
      }
    })

    await ctx.tool.hook('execute.after', async (event) => {
      if (event.status !== 'completed') return
      if (event.tool !== 'edit' && event.tool !== 'write' && event.tool !== 'patch') return

      const input = event.input ?? {}
      const targets =
        event.tool === 'patch'
          ? appliedTargets(event.result)
          : [input.filePath ?? input.path]

      const notes = []
      for (const filePath of targets) {
        if (typeof filePath !== 'string') continue

        // edit rewrites part of a file: the old text is in the args.
        const before =
          event.tool === 'edit' && typeof input.oldString === 'string'
            ? readOrEmpty(filePath).replace(input.newString ?? '', input.oldString)
            : (seen.get(filePath) ?? '')
        seen.delete(filePath)

        const findings = checkFile(filePath, before, readOrEmpty(filePath))
        if (findings.length > 0) notes.push(report(findings, filePath))
      }
      if (notes.length === 0) return

      const note = truncate(notes.join('\n\n'))
      const existing = typeof event.result.content === 'string' ? event.result.content : ''
      event.result = {
        ...event.result,
        content: existing ? `${existing}\n\n${note}` : note,
      }
    })
  },
}
