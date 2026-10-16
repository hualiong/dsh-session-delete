// dsh-session-delete: HOST half.
//
// Deletes one session end-to-end, together with the subagent sessions hanging
// off it:
//   POST /__chameleon/session/delete  - HTTP endpoint for the client button,
//                                       driven by the person only
//   session_list / session_delete     - agent tools (opt-out through the
//                                       profile config key `exposeAgentTools`),
//                                       guarded: never the caller's own session,
//                                       never a busy session or subtree;
//                                       live-but-idle is deletable, like the
//                                       button
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
//      clear the registry-global archive and pin flags;
//   6. repeat 1-5 for every descendant subagent session, parent last;
//   7. tell connected clients every removed id is gone (`api-session/removed`).
import fs from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'chameleon-session-delete'
// No required services: `webServer`, `workspaceRegistry` and `tools` are
// optional (terminal-only and query-only profiles have none) and injected in
// apply. `sessionQuery` and `storageDomain` are read defensively instead.
const inject = []

// Settings switch (plugin row -> Configure): whether the two agent tools are
// registered. `volatile` is what makes the field editable at runtime without a
// plugin remount, and dsh-settings only describes entries that carry at least
// one such field — without it the row would have no settings form at all.
const Config = z.object({
  exposeAgentTools: z.boolean().default(true).volatile().description(
    'Expose the session_list / session_delete tools to agents. Turning it off keeps the sidebar button working.',
  ),
})

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

// Collapse either spelling to the bare uuid, the only form two independent
// stores can be joined on.
function normId(id) {
  return id.startsWith('session-') ? id.slice(8) : id
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

// Delete the log dir(s) and report what survived, so the caller never has to
// rescan the whole sessions tree to find out (and fails on exactly the paths
// this call could not remove, not on some unrelated stray directory).
function removeSessionDirs(sessionId) {
  const dirs = findSessionDirs(sessionId)
  const remaining = []
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
    if (fs.existsSync(dir)) remaining.push(dir)
  }
  return { removed: dirs.length > 0, remaining }
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

// Detach the workspace accounting slot and clear the archive and pin flags
// through the official registry. Every call is idempotent; an absent registry
// (headless composition) is simply no accounting to clean.
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
    if (registry.pinnedSessionIds?.includes(sessionId)) {
      await registry.unpinSession(sessionId)
      removed = true
    }
  } catch { /* registry not open yet: nothing durable to clean */ }
  return removed
}

// Take a live session out of play in one pass per id spelling: flush first so
// dispose-time teardown has no pending write to re-create the log after
// deletion, then detach — the store's own teardown path, which deletes the
// entry and emits session/disposed (the official controller relays that to
// every client as `api-session/removed`).
async function retireLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function' || !sessions.store) return false
  let detached = false
  for (const variant of sessionIdVariants(sessionId)) {
    const session = sessions.get(variant)
    if (session) {
      try {
        await sessions.flush(session)
      } catch { /* deletion proceeds and removes the log anyway */ }
    }
    const entry = sessions.store.get(variant)
    if (entry === undefined) continue
    try {
      sessions.detachEntered(entry)
      detached = true
    } catch { /* ignore */ }
  }
  return detached
}

// Persistent subagent sessions hang off their parent via the log header's
// parentSession link; deleting a parent without them strands them as sidebar
// rows pointing at a dead parent forever. Resolve the transitive relationship
// through sessionQuery's own records (no fs scan, no log decompression).
// Both sides of the join are normalized: header ids and parentSession links
// are stored in either spelling depending on how the session was created, so
// a raw join silently loses every level below the first.
// ponytail: full closure via listSessions (one pass over ~300 records); a
// sqlite parent-index matters only if corpus size ever makes this visible.
async function descendantSessionIds(ctx, sessionId) {
  const sq = ctx.get('sessionQuery')
  if (!sq || typeof sq.listSessions !== 'function') return []
  const records = await sq.listSessions()
  const byParent = new Map()
  for (const r of records) {
    const parent = r.header.parentSession
    if (!parent) continue
    const key = normId(parent)
    const kids = byParent.get(key) ?? []
    kids.push(r.header.id)
    byParent.set(key, kids)
  }
  const root = normId(sessionId)
  const out = new Set()
  const queue = [sessionId]
  while (queue.length > 0) {
    const parent = queue.pop()
    for (const child of byParent.get(normId(parent)) ?? []) {
      if (normId(child) === root || out.has(child)) continue // lineage cycles exist; never re-queue the root
      out.add(child)
      queue.push(child)
    }
  }
  return [...out]
}

// Host-initiated deletions tell connected clients the session is gone.
// `api-session/removed` is the controller's own relayed removal frame
// (normally emitted from session/disposed, which never fires for an
// already-ended session): the client handler applies a remove mutation, so the
// sidebar row drops immediately, like the button path.
// The client half cannot be reached directly from here — handleSessionRemoved
// lives in the webview's client sessions manager, and this code runs in the
// host process; gateway-relayed events are the sanctioned host→client channel.
// Every removal frame is idempotent client-side, so relaying it next to the
// session/disposed one is safe.
function announceRemoval(ctx, sessionId) {
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch { /* no relay surface: clients converge on the next full refresh */ }
}

// `victims` is the session plus its descendant subagent tree, parent last. An
// agent delete resolves the tree up front (it has to, for the busy guard) and
// hands the very same list in, so the guard and the deletion cannot disagree.
async function deleteSessionCore(ctx, sessionId, victims) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new DeleteError(`invalid session id: ${sessionId}`, 400)
  }
  if (victims === undefined) victims = [...(await descendantSessionIds(ctx, sessionId)), sessionId]
  const removed = []
  let detached = 0
  let dirRemoved = 0
  let projRemoved = 0
  let workspaceRemoved = 0
  for (const id of victims) {
    if (await retireLiveSession(ctx, id)) detached++

    // Remove the on-disk log first; if the filesystem refuses, fail before
    // touching accounting so a half-deleted session cannot fall out of its
    // group into "Ungrouped".
    const { removed: dirsGone, remaining } = removeSessionDirs(id)
    if (remaining.length > 0) {
      throw new DeleteError(`session files could not be fully removed: ${remaining.join(', ')}`, 500)
    }

    // Per-victim results only: carrying one victim's success into the next
    // would report (and announce) a parent that removed nothing as deleted.
    const projGone = await stripProjCache(ctx, id)
    const workspaceGone = await stripWorkspaceAccounting(ctx, id)
    if (dirsGone) dirRemoved++
    if (projGone) projRemoved++
    if (workspaceGone) workspaceRemoved++
    if (dirsGone || projGone || workspaceGone) removed.push(id)
  }
  if (removed.length === 0) {
    throw new DeleteError(`session not found: ${sessionId}`, 404)
  }
  // Announced here rather than at each call site: every caller (button route,
  // agent tool) owes connected clients the row drop, and only what was really
  // removed is announced.
  for (const id of removed) announceRemoval(ctx, id)
  return {
    removed,
    detached,
    dirRemoved: dirRemoved > 0,
    projRemoved: projRemoved > 0,
    workspaceRemoved: workspaceRemoved > 0,
  }
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

// --- agent tools ----------------------------------------------------------------
// session_list: group/session metadata for the delete flow; session_delete:
// end a session by id, never the caller's own, never a busy one.
//
// Both definitions use the official author face that `defineTool` consumes
// (`parameters` is the property map and a property marks itself `required`) —
// the same posture every built-in tool plugin takes, including the static
// import: DSH resolves installation-scoped `@deepseek-ai/*` packages for
// profile plugins through its profile-resolution interception.
const TOOL_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function toolGuardError(message) {
  const e = new Error(message)
  e.code = 'SESSION_DELETE_REFUSED'
  return e
}

// The agent tool may only delete a session with no running work: an active
// turn (the model is mid-conversation), running subagent descendants (a parent
// waiting on children), active schedules, or jobs. Ask the same
// `workspace/session-activity` waterfall the runtime's own archive admission
// uses, so the busy-definition stays in lockstep with the product. A merely
// live (retained but idle) session is deletable, like the client button.
async function sessionBusyActivity(ctx, sessionId) {
  try {
    return await ctx.waterfall('workspace/session-activity', { sessionId }, () => [])
  } catch {
    return [] // no waterfall surface: nothing reported, deletable
  }
}

async function executeSessionDelete(ctx, args, exec) {
  const sessionId = String(args?.session_id ?? '').trim()
  if (!sessionId) throw toolGuardError('session_id is required')
  if (!exec.agent) throw toolGuardError('session_delete requires an agent-bound caller')
  if (normId(sessionId) === normId(exec.agent.session.id)) {
    throw toolGuardError('refusing to delete the current session')
  }
  const activity = await sessionBusyActivity(ctx, sessionId)
  if (activity.length > 0) {
    throw toolGuardError(`session is busy (${activity.map((a) => a.kind).join(', ')}); end its work before deleting`)
  }
  // Fail before any write if a descendant subagent is still working: the
  // cascade would otherwise cut a mid-turn child's log.
  const descendants = await descendantSessionIds(ctx, sessionId)
  for (const child of descendants) {
    const childActivity = await sessionBusyActivity(ctx, child)
    if (childActivity.length > 0) {
      throw toolGuardError(`descendant ${child} is busy (${childActivity.map((a) => a.kind).join(', ')}); end it before deleting the tree`)
    }
  }
  try {
    const result = await deleteSessionCore(ctx, sessionId, [...descendants, sessionId])
    return `deleted ${result.removed.join(', ')}: detached=${result.detached} logDirs=${result.dirRemoved} projCache=${result.projRemoved} workspace=${result.workspaceRemoved}`
  } catch (e) {
    if (e instanceof DeleteError && e.status === 404) return `nothing to delete: session ${sessionId} not found`
    throw e
  }
}

// --- session_list ---------------------------------------------------------------
const MAX_LISTED_SESSIONS = 400

// Titles are decoration: a failed snapshot read degrades to 'untitled' rather
// than failing the listing.
async function readSessionTitles(sq, ids, signal) {
  try {
    const map = new Map()
    for (const o of await sq.readTitleSnapshots(ids, signal)) {
      if (o.status === 'fulfilled' && o.value.title?.title) map.set(normId(o.sessionId), o.value.title.title)
    }
    return map
  } catch { /* titles are decoration; the list survives without them */ }
  return new Map()
}

function sessionLine(record, titles) {
  const h = record.header
  const label = titles.get(normId(h.id)) ?? 'untitled'
  return `\n- ${h.id}  ${label}  ${new Date(h.createdAt).toISOString()}${record.live ? '  [live]' : ''}`
}

async function executeSessionList(ctx, args, exec) {
  const sq = ctx.get('sessionQuery')
  if (!sq || typeof sq.listSessions !== 'function') {
    return 'session query service unavailable on this profile (a session-query bundle provides it)'
  }
  const ws = ctx.get('workspaceRegistry')
  const workspaces = (typeof ws?.list === 'function' ? ws.list() : [])
  const wanted = String(args?.workspace_id ?? '').trim()
  // Drill-down (key comes from a previous group-level call; 'ungrouped' lists
  // sessions not attached to any workspace on disk).
  if (wanted) {
    let records = await sq.listSessions(exec.signal)
    // Sidebar parity: subagent children are parent-scoped rows the UI never
    // shows as sessions (sessionVisible rejects origin==="subagent"), so they
    // are excluded from the listing too; deletion still reaches them through
    // the parentSession-link cascade, they just stay invisible until then.
    records = records.filter((r) => r.header.origin !== 'subagent')
    const byId = new Map(records.map((r) => [normId(r.header.id), r]))
    let picked, title, header
    if (wanted === 'ungrouped') {
      const attached = new Set(workspaces.flatMap((x) => x.sessionIds.map(normId)))
      picked = [...byId.entries()].filter(([id]) => !attached.has(id)).map(([, r]) => r)
      title = 'Ungrouped'
      header = ''
    } else {
      const w = workspaces.find((x) => x.path === wanted)
      if (!w) return `unknown workspace: ${wanted} (keys come from a bare session_list call)`
      picked = w.sessionIds.map((id) => byId.get(normId(id))).filter(Boolean)
      title = w.title
      header = `  ${w.path}`
    }
    if (picked.length > MAX_LISTED_SESSIONS) picked = picked.slice(0, MAX_LISTED_SESSIONS)
    const titles = await readSessionTitles(sq, picked.map((r) => r.header.id), exec.signal)
    const lines = [`# ${title}${header}  (${picked.length})`]
    for (const r of picked) lines.push(sessionLine(r, titles))
    return lines.join('')
  }
  // Group level: groups only, no per-session rows and no title folding.
  const records = (await sq.listSessions(exec.signal)).filter((r) => r.header.origin !== 'subagent')
  const attached = new Set(workspaces.flatMap((x) => x.sessionIds.map(normId)))
  const ungrouped = records.filter((r) => !attached.has(normId(r.header.id)))
  const lines = [`workspaces: ${workspaces.length}, attached: ${attached.size}, ungrouped: ${ungrouped.length}`]
  for (const w of workspaces) {
    // path is the drill-down key: workspace records carry no stable id field,
    // while canonical realpath is unique and immutable.
    lines.push(`\n# ${w.title}  key=${w.path}  (${w.sessionIds.length})`)
  }
  if (ungrouped.length > 0) lines.push(`\n# Ungrouped  key=ungrouped  (${ungrouped.length})`)
  return lines.join('')
}

// --- plugin -------------------------------------------------------------------
// webServer and tools are OPTIONAL (a terminal-only profile has no web surface,
// a query-only profile no agent tools): each capability registers when its
// service exists or appears later (ctx.inject child). The settings key
// `exposeAgentTools: false` keeps the two tools unregistered while the client
// button route stays available.

function apply(ctx, config) {
  const exposeAgentTools = config?.exposeAgentTools !== false

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
          sendJson(res, 200, { ok: true, ...result })
        } catch (e) {
          const status = e instanceof DeleteError && e.status ? e.status : 500
          sendJson(res, status, { error: e.message })
        }
      },
    }))
  }

  ctx.inject(['webServer'], (sub) => registerHttp(sub.webServer, sub))

  if (exposeAgentTools) {
    ctx.inject(['tools'], (sub) => registerTools(sub, sub.tools))
  }
}

function registerTools(ctx, tools) {
  const specs = [
    {
      name: 'session_list',
      description: "List sessions of this profile grouped by workspace (title is the group name): one line per session with id, title, creation time, and a [live] mark (subagent children are hidden, like the sidebar). Use it to pick a session_id for session_delete or session queries.",
      parameters: {
        workspace_id: {
          type: 'string',
          description: "Workspace key (the workspace's path) or the literal 'ungrouped' from a previous bare call, to drill into one group. Omit to list only the groups.",
        },
      },
      output: TOOL_OUTPUT,
      execute: (args, exec) => executeSessionList(ctx, args, exec),
    },
    {
      name: 'session_delete',
      description: "Permanently delete one session of this profile by id, including live (retained-but-idle) ones — they are flushed and detached first — together with its subagent sessions. Refuses the caller's own current session and any busy session (a running turn, running subagent descendants, active schedules or jobs). Only ended or idle sessions can be deleted by the agent.",
      parameters: {
        session_id: {
          type: 'string',
          description: 'Exact session id of a non-live session, e.g. "session-0123abcd-...".',
          required: true,
        },
      },
      output: TOOL_OUTPUT,
      execute: (args, exec) => executeSessionDelete(ctx, args, exec),
    },
  ]

  for (const spec of specs) ctx.effect(() => tools.register(defineTool(spec)))
}

export { Config, apply, inject, name }
