// dsh-session-delete: HOST half.
//
// Deletes one session end-to-end:
//   POST /__chameleon/session/delete  - HTTP endpoint for the client button,
//                                       driven by the person only: no agent tool
//
// Deletion steps, kept consistent with the live storage services so in-memory
// state and on-disk units stay in sync (no "resurrected" session after the
// next periodic flush):
//   1. flush a live session so dispose-time teardown has no pending writes;
//   2. detach the live session from the store (its dispose emits
//      session/disposed, which the official controller relays to the client);
//   3. remove the persisted log dir(s) and confirm they are gone before
//      touching accounting, so a half-deleted session cannot fall out of its
//      group into "Ungrouped";
//   4. drop the projection-cache row (storageDomain 'session_projcache');
//   5. detach workspace accounting through the official workspaceRegistry and
//      clear the registry-global archive flag.
import fs from 'node:fs'
import path from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const name = 'chameleon-session-delete'
// No required services: `webServer` and `workspaceRegistry` are optional
// (terminal-only profiles have neither) and injected in apply.
const inject = []

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class DeleteError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

// Session ids appear in two spellings across stores: the raw id (`<uuid>`)
// and the prefixed form (`session-<uuid>`). Return every unique spelling.
function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) {
    variants.add(sessionId.slice('session-'.length))
  } else if (SESSION_ID_RE.test(sessionId)) {
    variants.add(`session-${sessionId}`)
  }
  return [...variants]
}

// Locate ~/.dsh/sessions/<slug>/<sessionId>/ by scanning every project slug
// dir, so the workspace-path encoding never has to be re-derived here.
function findSessionDirs(sessionId) {
  const root = dshHomePath('sessions')
  const variants = sessionIdVariants(sessionId)
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, entry.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch { /* keep scanning */ }
    }
  }
  return found
}

function removeSessionDirs(sessionId) {
  const dirs = findSessionDirs(sessionId)
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return dirs.length > 0
}

// Drop the projection-cache row for every id spelling. Uses the opened domain
// facility so the periodic flush can never re-publish a stale row.
async function stripProjCache(ctx, sessionId) {
  const sd = ctx.get('storageDomain')
  const proj = sd?.get('session_projcache')
  if (!proj || typeof proj.table !== 'function') return false
  let removed = false
  try {
    const sessions = proj.table('sessions')
    for (const variant of sessionIdVariants(sessionId)) {
      if (await sessions.delete(variant)) removed = true
    }
  } catch { /* unit closed or table absent: nothing to clean */ }
  return removed
}

// Detach the workspace accounting slot and clear the archive flag through the
// official registry. Both calls are idempotent; an absent registry (headless
// composition) is simply no accounting to clean.
async function stripWorkspaceAccounting(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return false
  let removed = false
  try {
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(sessionId)) continue
      await workspace.detachSession(sessionId)
      removed = true
    }
    if (registry.archivedSessionIds.includes(sessionId)) {
      await registry.unarchiveSession(sessionId)
      removed = true
    }
  } catch { /* registry not open yet: nothing durable to clean */ }
  return removed
}

// Flush a live session before detaching it, so dispose-time teardown has no
// pending writes to re-create the log directory after deletion.
async function flushSessionIfLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return
  for (const variant of sessionIdVariants(sessionId)) {
    const session = sessions.get(variant)
    if (!session) continue
    try {
      await sessions.flush(session)
    } catch { /* deletion proceeds and removes the log anyway */ }
  }
}

// Remove the session from the in-memory store so host session lists stop
// returning it and no flush can re-materialize its files. detachEntered is the
// store's own teardown path (deletes the entry and emits session/disposed).
function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return false
  let detached = false
  try {
    for (const variant of sessionIdVariants(sessionId)) {
      const entry = sessions.store.get(variant)
      if (entry === undefined) continue
      sessions.detachEntered(entry)
      detached = true
    }
  } catch { /* ignore */ }
  return detached
}

async function deleteSessionCore(ctx, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new DeleteError(`invalid session id: ${sessionId}`, 400)
  }
  await flushSessionIfLive(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)

  // Remove the on-disk log first; if the filesystem refuses, fail before
  // touching accounting so a half-deleted session cannot fall out of its
  // group into "Ungrouped".
  const dirRemoved = removeSessionDirs(sessionId)
  const remainingDirs = findSessionDirs(sessionId)
  if (remainingDirs.length > 0) {
    throw new DeleteError(`session files could not be fully removed: ${remainingDirs.join(', ')}`, 500)
  }

  const projRemoved = await stripProjCache(ctx, sessionId)
  const workspaceRemoved = await stripWorkspaceAccounting(ctx, sessionId)
  if (!dirRemoved && !projRemoved && !workspaceRemoved) {
    throw new DeleteError(`session not found: ${sessionId}`, 404)
  }
  return { detached, dirRemoved, projRemoved, workspaceRemoved }
}

// --- http helpers -------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// --- plugin -------------------------------------------------------------------
// webServer is OPTIONAL (a terminal-only profile has no web surface): the HTTP
// endpoint registers when the service exists or appears later (ctx.inject
// child). No agent tool is registered: deletion is the person's decision.

function apply(ctx) {
  function registerHttp(host, targetCtx) {
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__chameleon/session/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let args = {}
        try {
          const body = await readBody(req)
          if (body) args = JSON.parse(body)
        } catch {
          sendJson(res, 400, { error: 'bad json body' })
          return
        }
        const sessionId = String(args.sessionId || '').trim()
        if (!sessionId) {
          sendJson(res, 400, { error: 'sessionId required' })
          return
        }
        try {
          const result = await deleteSessionCore(ctx, sessionId)
          sendJson(res, 200, { ok: true, removed: [sessionId], ...result })
        } catch (e) {
          const status = e instanceof DeleteError && e.status ? e.status : 500
          sendJson(res, status, { error: e.message })
        }
      },
    }))
  }

  const ws = ctx.get('webServer')
  if (ws !== undefined) {
    registerHttp(ws, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => {
      registerHttp(sub.webServer, sub)
    })
  }
}

export { apply, inject, name }
