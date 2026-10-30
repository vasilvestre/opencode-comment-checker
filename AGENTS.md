# AGENTS.md — maintainer instructions

Instructions for agents working in this repository.

## What this repo ships

One OpenCode v2 plugin: `@vasilvestre/opencode-comment-checker`.

After an `edit`, `write`, or `patch`, it scans the comments the tool added and
appends a warning to the tool result when one only restates the code. The model
reads the warning on its next turn and fixes it.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | the plugin, and the only runtime file |
| `index.test.mjs` | 17 tests, `node:test`, no dependency |
| `README.md` | public usage, rules, escape hatches, difference from omo |
| `.github/workflows/ci.yml` | tests on pull request and push |
| `.github/workflows/release.yml` | publishes on version bump |

## Hard rules

- **Never block a write.** The plugin warns; it does not fail the tool. A false
  positive must never cost the user a working edit.
- **Only judge lines the tool added.** Pre-existing comments are not the agent's
  work. `execute.before` records the file so `execute.after` can tell them apart.
- **A brand-new file has no previous state.** Do not record an empty string for
  a path that does not exist yet: every line would look pre-existing and no
  finding would ever surface.
- **`patch` paths are relative to the workspace**, not to the server's working
  directory. Read the resolved paths from `result.output.applied[].target`.
- **The warning stays bounded.** `MAX_REPORT_CHARS` caps it at 2000 characters.
  A large patch must not push a long session into compaction.
- **Unknown extensions are skipped, not guessed.** A missing entry in `SYNTAX`
  means the file is not checked.
- **No dependency.** The plugin imports `node:fs` and nothing else. Adding a
  package to a 5 kB plugin is a cost the user pays on every install.

## The rules

Five patterns, each returning a reason the model can act on:

| Rule | Example |
| --- | --- |
| `restates-next-line` | `// increment counter` above `increment(counter)` |
| `restates-name` | `// helper` above `function helper()` |
| `bare-todo` | `// TODO fix this later` |
| `commented-code` | `// const total = price * qty;` |
| `decorative-banner` | `// ==========` |

A new rule needs a test that fails without it and passes with it. A rule that
fires on a why-comment is a bug, not a tuning problem.

## Escape hatches

`@allow` on a line, `comment-checker-disable-file` anywhere in the file. Both
are tested. Do not remove either without a replacement.

## Before you commit

```bash
npm test
```

Every change to `index.js` needs a test. The suite caught three real bugs that
were invisible by reading: the new-file case, the TODO owner pattern, and the
relative `patch` path.

## Release

Published to npm. `.github/workflows/release.yml` publishes on every push to
`main` when the version in `package.json` is not on npm yet.

Bumping the version is the release decision:

```bash
npm version patch   # or minor, or major
git push --follow-tags
```

The workflow stops at "Skip when already published" when the version is
unchanged. It never invents a version. `ci.yml` runs the tests only.

The npm trusted publisher points at `vasilvestre/opencode-comment-checker`,
workflow `release.yml`.

## Commits

Imperative subject, 72 characters or fewer, no trailing period. Say what
changed and why, not how.
