import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Exercise the real component's save functions, not a copied implementation.
// This is a deterministic function-level regression suite: it does not mount React,
// run effects, touch browser storage, call a server, or replace GUI / integration tests.
const source = readFileSync(new URL('../src/pages/ChapterEditor.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('ChapterEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const documentFunction = ast.statements.find(
  statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'ChapterDocument'
)
assert.ok(documentFunction?.body, 'ChapterDocument changed: update the save test harness')

function variableSource(statements, name) {
  const statement = statements.find(
    candidate =>
      ts.isVariableStatement(candidate) &&
      candidate.declarationList.declarations.some(
        declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name
      )
  )
  assert.ok(statement, `${name} changed: update the save test harness`)
  return statement.getText(ast)
}

const executable = ts.transpileModule(
  [
    variableSource(ast.statements, 'hasChanges'),
    variableSource(documentFunction.body.statements, 'persistDraft'),
    variableSource(documentFunction.body.statements, 'save'),
    'return { persistDraft, save };'
  ].join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

function createHarness() {
  const session = {
    base: { index: 1, oid: 'stable-oid', title: 'Chapter', content: 'Base', words: 4, status: 'done' },
    title: 'Chapter',
    content: 'Base',
    key: 'writer-draft:test-book:stable-oid',
    owner: 'first-session',
    lastDraft: null,
    saving: false,
    blocked: false,
    conflict: false,
    recovered: false,
    cacheFailed: false,
    error: '',
    notice: '',
    composing: false
  }
  const storage = new Map()
  const calls = []
  const requests = []
  const events = []
  const mountedRef = { current: true }
  const api = {
    updateChapter: (id, index, data) => {
      calls.push({ id, index, data })
      return new Promise((resolve, reject) => requests.push({ resolve, reject }))
    }
  }
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  }
  const createSaveFunctions = new Function(
    'sessionRef',
    'mountedRef',
    'api',
    'id',
    'refresh',
    'localStorage',
    'window',
    'toast',
    'ApiError',
    executable
  )
  const functions = createSaveFunctions(
    { current: session },
    mountedRef,
    api,
    'test-book',
    () => {},
    localStorage,
    { dispatchEvent: event => events.push(event.type) },
    { success: () => {} },
    ApiError
  )
  return {
    ...functions,
    session,
    storage,
    calls,
    requests,
    events,
    mountedRef,
    draft: () => JSON.parse(storage.get(session.key) || 'null'),
    input(content) {
      session.content = content
      functions.persistDraft(true)
    }
  }
}

// Drain resolved promise continuations without a wall-clock sleep.
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

test(
  'editor save: input added during a delayed save survives unmount and uses the next optimistic lock',
  { timeout: 3000 },
  async () => {
    const h = createHarness()
    h.input('First input')
    const pending = h.save()
    assert.equal(h.session.saving, true)
    assert.equal(h.calls.length, 1)

    h.input('First input plus the last keystrokes')
    assert.equal(h.draft().content, 'First input plus the last keystrokes')
    h.mountedRef.current = false
    h.persistDraft()
    assert.equal(await h.save(false), false, 'unmount must not start a parallel request')
    assert.equal(h.calls.length, 1)

    h.requests[0].resolve({ ok: true })
    await nextTurn()
    assert.equal(h.calls.length, 2)
    assert.deepEqual(h.calls[1], {
      id: 'test-book',
      index: 1,
      data: {
        title: 'Chapter',
        content: 'First input plus the last keystrokes',
        oid: 'stable-oid',
        expectedContent: 'First input',
        expectedTitle: 'Chapter'
      }
    })
    assert.equal(h.draft().expectedContent, 'First input')
    h.requests[1].resolve({ ok: true })
    assert.equal(await pending, true)
    assert.equal(h.session.base.content, 'First input plus the last keystrokes')
    assert.equal(h.session.saving, false)
    assert.equal(h.storage.size, 0)
    assert.deepEqual(h.events, ['writer-chapter-saved', 'writer-chapter-saved'])
  }
)

test(
  'editor save: network failure retains a recoverable draft and its original baseline',
  { timeout: 3000 },
  async () => {
    const h = createHarness()
    h.input('Recover this text')
    const pending = h.save()
    h.requests[0].reject(new Error('Offline'))
    assert.equal(await pending, false)
    assert.equal(h.draft().content, 'Recover this text')
    assert.equal(h.draft().expectedContent, 'Base')
    assert.equal(h.draft().expectedTitle, 'Chapter')
    assert.equal(h.draft().oid, 'stable-oid')
    assert.equal(h.session.blocked, true)
    assert.equal(h.session.saving, false)
    assert.equal(await h.save(false), false, 'autosave must wait for an explicit retry')
    assert.equal(h.calls.length, 1)

    const retry = h.save()
    assert.equal(h.calls[1].data.expectedContent, 'Base')
    h.requests[1].resolve({ ok: true })
    assert.equal(await retry, true)
    assert.equal(h.storage.size, 0)
  }
)

test('editor save: HTTP 409 blocks overwriting and retains subsequent local input', { timeout: 3000 }, async () => {
  const h = createHarness()
  h.input('Conflicting input')
  const pending = h.save()
  h.requests[0].reject(new ApiError('Conflict', 409))
  assert.equal(await pending, false)
  assert.equal(h.session.conflict, true)
  assert.equal(h.session.blocked, true)
  assert.equal(h.draft().content, 'Conflicting input')

  h.input('Conflicting input with more local edits')
  assert.equal(await h.save(), false)
  assert.equal(await h.save(false), false)
  assert.equal(h.calls.length, 1)
  assert.equal(h.draft().content, 'Conflicting input with more local edits')
  assert.equal(h.draft().expectedContent, 'Base')
  assert.equal(h.events.length, 0)
})

test(
  'editor save: an old in-flight session cannot delete or replace a newly claimed draft',
  { timeout: 3000 },
  async () => {
    const h = createHarness()
    h.input('Old snapshot')
    const pending = h.save()
    h.input('Old snapshot with pending input')
    h.mountedRef.current = false
    const newDraft = JSON.stringify({
      owner: 'new-session',
      oid: 'stable-oid',
      title: 'Chapter',
      content: 'New session input',
      expectedTitle: 'Chapter',
      expectedContent: 'Base'
    })
    h.storage.set(h.session.key, newDraft)
    h.requests[0].resolve({ ok: true })
    assert.equal(await pending, false)
    assert.equal(h.storage.get(h.session.key), newDraft)
    assert.equal(h.calls.length, 1, 'the old session must not send another snapshot after ownership changes')
    assert.equal(h.session.saving, false)
  }
)

test('editor save: a blank title normalizes without an endless autosave loop', { timeout: 3000 }, async () => {
  const h = createHarness()
  h.session.title = '   '
  h.input('Text with a blank title')
  const pending = h.save()
  assert.equal(h.calls[0].data.title, 'Chapter')
  h.requests[0].resolve({
    ok: true,
    chapter: { ...h.session.base, title: 'Chapter', content: 'Text with a blank title', status: 'done' }
  })
  assert.equal(await pending, true)
  assert.equal(h.session.title, 'Chapter')
  assert.equal(await h.save(false), true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.storage.size, 0)
})
