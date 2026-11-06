// Tests for the destructive half of the plugin: id validation, the subagent
// cascade, storage cleanup, partial-failure reporting and the HTTP gate.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  apply,
  DeleteError,
  deleteSessionCore,
  descendantSessionIds,
  normId,
  sessionIdVariants,
} from '../src/index.js'

const ROOT_ID = 'session-11111111-1111-4111-8111-111111111111'
const CHILD_ID = 'session-22222222-2222-4222-8222-222222222222'
const FORK_ID = 'session-33333333-3333-4333-8333-333333333333'
const SCHEDULE_ID = `session-schedule-${'a'.repeat(64)}`

let home
let previousHome

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-delete-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})

function makeSessionDir(id, project = 'project') {
  const dir = path.join(home, 'sessions', project, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'log')
  return dir
}

function makeServices({ records = [], live = new Map(), proj = new Set(), workspaces = [], archived = [], pinned = [] } = {}) {
  const events = []
  const parallelCalls = []
  const sessions = { get: (id) => live.get(id), store: new Map() }
  const projTable = { delete: async (key) => proj.delete(key) }
  const services = {
    events,
    parallelCalls,
    proj,
    workspaces,
    sessions,
    get(key) {
      if (key === 'sessions') return sessions
      if (key === 'sessionQuery') return { listSessions: async () => records }
      if (key === 'storageDomain') {
        return { get: (name) => (name === 'session_projcache' ? { table: () => projTable } : undefined) }
      }
      if (key === 'workspaceRegistry') return { list: () => workspaces, archivedSessionIds: archived, pinnedSessionIds: pinned }
      return undefined
    },
    emit(event, id) {
      events.push([event, id])
    },
    parallel(event, args) {
      parallelCalls.push([event, args])
    },
  }
  return services
}

function workspaceFor(sessionIds) {
  const workspace = {
    sessionIds: [...sessionIds],
    detached: [],
    async detachSession(id) {
      this.detached.push(id)
      this.sessionIds = this.sessionIds.filter((candidate) => candidate !== id)
    },
  }
  return workspace
}

function record(id, parentSession) {
  return { header: { id, ...(parentSession === undefined ? {} : { parentSession, origin: 'subagent' }) } }
}

test('rejects ids that are not one safe path segment', async () => {
  const outside = path.join(home, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
  const services = makeServices()

  for (const id of ['../../outside', 'a/b', '..', '.', '', 'x'.repeat(500)]) {
    await assert.rejects(deleteSessionCore(services, id), (error) => {
      assert.ok(error instanceof DeleteError)
      assert.equal(error.status, 400)
      return true
    })
  }
  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true)
})

test('validates every cascade victim before deleting anything', async () => {
  const rootDir = makeSessionDir(ROOT_ID)
  const outside = path.join(home, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
  const services = makeServices({
    records: [record(ROOT_ID), { header: { id: '../../outside', parentSession: ROOT_ID, origin: 'subagent' } }],
  })

  await assert.rejects(deleteSessionCore(services, ROOT_ID), (error) => error.status === 400)
  assert.equal(fs.existsSync(rootDir), true)
  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true)
})

test('deletes a session and its subagent tree, and stops their work first', async () => {
  const rootDir = makeSessionDir(ROOT_ID)
  const childDir = makeSessionDir(CHILD_ID)
  const proj = new Set([ROOT_ID, CHILD_ID])
  const workspace = workspaceFor([ROOT_ID, CHILD_ID])
  const services = makeServices({
    records: [record(ROOT_ID), record(CHILD_ID, ROOT_ID)],
    proj,
    workspaces: [workspace],
  })

  const result = await deleteSessionCore(services, ROOT_ID)

  assert.deepEqual(result.removed, [CHILD_ID, ROOT_ID])
  assert.equal(fs.existsSync(rootDir), false)
  assert.equal(fs.existsSync(childDir), false)
  assert.equal(proj.size, 0)
  assert.deepEqual(workspace.detached, [CHILD_ID, ROOT_ID])
  assert.deepEqual(services.parallelCalls, [
    ['workspace/session-stop', { sessionId: CHILD_ID }],
    ['workspace/session-stop', { sessionId: ROOT_ID }],
  ])
  assert.deepEqual(services.events, [
    ['api-session/removed', CHILD_ID],
    ['api-session/removed', ROOT_ID],
  ])
})

test('a schedule-created session id is deletable', async () => {
  const dir = makeSessionDir(SCHEDULE_ID)
  const proj = new Set([SCHEDULE_ID])
  const services = makeServices({ proj })

  const result = await deleteSessionCore(services, SCHEDULE_ID)

  assert.deepEqual(result.removed, [SCHEDULE_ID])
  assert.equal(fs.existsSync(dir), false)
})

test('a lineage-only fork is not deleted with its source', async () => {
  const rootDir = makeSessionDir(ROOT_ID)
  const forkDir = makeSessionDir(FORK_ID)
  const services = makeServices({
    records: [record(ROOT_ID), { header: { id: FORK_ID, parentSession: ROOT_ID } }],
  })

  const result = await deleteSessionCore(services, ROOT_ID)

  assert.deepEqual(result.removed, [ROOT_ID])
  assert.equal(fs.existsSync(rootDir), false)
  assert.equal(fs.existsSync(forkDir), true)
})

test('an unknown session is a 404', async () => {
  const services = makeServices()
  await assert.rejects(deleteSessionCore(services, ROOT_ID), (error) => {
    assert.ok(error instanceof DeleteError)
    assert.equal(error.status, 404)
    return true
  })
})

test('a failed cascade reports and announces what was already removed', async () => {
  makeSessionDir(ROOT_ID)
  makeSessionDir(CHILD_ID)
  const services = makeServices({
    records: [record(ROOT_ID), record(CHILD_ID, ROOT_ID)],
    proj: new Set([ROOT_ID]),
  })
  const realRmSync = fs.rmSync
  const rootPath = path.join(home, 'sessions', 'project', ROOT_ID)
  fs.rmSync = (target, options) => {
    if (path.resolve(target) === path.resolve(rootPath)) throw new Error('locked by another process')
    return realRmSync(target, options)
  }
  try {
    await assert.rejects(deleteSessionCore(services, ROOT_ID), (error) => {
      assert.ok(error instanceof DeleteError)
      assert.deepEqual(error.removed, [CHILD_ID])
      assert.match(error.message, /already removed/)
      return true
    })
  } finally {
    fs.rmSync = realRmSync
  }
  assert.deepEqual(services.events, [['api-session/removed', CHILD_ID]])
})

test('descendants are found across id spellings and cycles are visited once', async () => {
  const services = makeServices({
    records: [
      record(ROOT_ID),
      { header: { id: CHILD_ID, parentSession: normId(ROOT_ID).replace(/^/, 'session-'), origin: 'subagent' } },
      { header: { id: FORK_ID, parentSession: ROOT_ID } },
    ],
  })
  assert.deepEqual(await descendantSessionIds(services, ROOT_ID), [CHILD_ID])
  assert.deepEqual(sessionIdVariants('2af434c7-88f4-4f4a-a428-bd5f0995c85a'), [
    '2af434c7-88f4-4f4a-a428-bd5f0995c85a',
    'session-2af434c7-88f4-4f4a-a428-bd5f0995c85a',
  ])
})

// --- HTTP route ---------------------------------------------------------------

function makePlugin(services) {
  let route
  const ctx = {
    ...services,
    inject(deps, callback) {
      if (deps.includes('webServer')) {
        callback({
          webServer: {
            register(candidate) {
              route = candidate
              return () => {}
            },
          },
          effect: (fn) => {
            fn()
            return () => {}
          },
        })
      }
    },
    effect: (fn) => {
      fn()
      return () => {}
    },
    on: () => () => {},
  }
  apply(ctx, { exposeAgentTools: true })
  return route
}

async function callRoute(route, { method = 'POST', headers = {}, body = '' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: '127.0.0.1:52478', ...headers }
  req.destroy = () => {}
  const res = {
    status: 0,
    payload: '',
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.payload = chunk ?? ''
    },
  }
  const pending = route.handler(req, res)
  setImmediate(() => {
    if (body !== '') req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  await pending
  return res
}

test('route refuses non-JSON, cross-origin and oversized requests', async () => {
  makeSessionDir(ROOT_ID)
  const route = makePlugin(makeServices())
  const body = JSON.stringify({ sessionId: ROOT_ID })

  assert.equal((await callRoute(route, { headers: { 'content-type': 'text/plain' }, body })).status, 403)
  assert.equal((await callRoute(route, {
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body,
  })).status, 403)
  assert.equal((await callRoute(route, { method: 'GET' })).status, 405)
  const oversized = `{"sessionId":"${ROOT_ID}","pad":"${'x'.repeat((1 << 20) + 10)}"}`
  assert.equal((await callRoute(route, {
    headers: { 'content-type': 'application/json' },
    body: oversized,
  })).status, 413)
})

test('route deletes for a same-origin JSON request', async () => {
  makeSessionDir(ROOT_ID)
  const proj = new Set([ROOT_ID])
  const route = makePlugin(makeServices({ proj }))

  const response = await callRoute(route, {
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:52478' },
    body: JSON.stringify({ sessionId: ROOT_ID }),
  })

  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.payload).ok, true)
  assert.equal(proj.size, 0)
})
