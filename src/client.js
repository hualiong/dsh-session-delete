// dsh-session-delete: CLIENT half.
//
// A sidebar "..." menu item opens one shared delete dialog through a private
// snapshot store (the same menu -> dialog shape ui-workspace uses for rename
// and archive). Deleting calls the host endpoint, then applies the official
// sessions-service removal so the sidebar list updates in place.
//
// It also owns the plugin's own configuration page (the switch that decides
// whether the two agent tools exist), see ToggleAgentToolsForm below.
window.__ModuleLoader__.load({
  id: '@hualiong/dsh-session-delete',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useState } = React
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const {
      Button,
      IconTrashOutlineRegular,
      MenuItemButton,
      Modal,
      Switch,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const ITEM_SLOT = 'sidebar.workspaces.session.menu.item'
    const ROW_ID = 'dsh-session-delete'
    const OVERLAY_SLOT = 'shell.overlay'
    const DIALOG_ID = 'dsh-session-delete-dialog'
    const ROW_CONFIG_SLOT = 'plugins.row.config'
    const MODULE_NAME = '@hualiong/dsh-session-delete'
    const ROW_ENTRY_ID = 'chameleon-session-delete'

    // --- locale ------------------------------------------------------------------

    const NS = 'dsh-session-delete'

    const zhDict = {
      'dialog.title': '删除会话',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.deleting': '正在删除…',
      'dialog.untitled': '未命名会话',
      'dialog.session': '会话：',
      'dialog.sessionId': '序列号：',
      'dialog.runningWarn': '⚠ 会话正在运行',
      'dialog.runningDesc': '该会话正在运行，删除会立即停止其任务并永久删除，正在进行的操作将中断且无法恢复。',
      'dialog.deleteDesc': '将先停止该会话正在运行的任务，再永久删除该会话及其全部子代理会话（会话日志、统计与工作区记账），此操作不可恢复。',
      'dialog.failed': '删除失败',
      'menu.delete': '删除会话',
      'config.toggleTitle': '向 Agent 暴露会话工具',
      'config.toggleDesc': '开启后，Agent 可调用 session_list / session_delete 来查看会话和删除。',
    }

    const enDict = {
      'dialog.title': 'Delete session',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.deleting': 'Deleting…',
      'dialog.untitled': 'Untitled session',
      'dialog.session': 'Session: ',
      'dialog.sessionId': 'Session ID: ',
      'dialog.runningWarn': '⚠ Session is running',
      'dialog.runningDesc': 'This session is running. Deleting it will stop its task immediately and remove it permanently; any work in progress will be interrupted and cannot be recovered.',
      'dialog.deleteDesc': 'This will stop any running work, then permanently delete the session and all of its subagent sessions (session log, statistics and workspace accounting). This action cannot be undone.',
      'dialog.failed': 'Delete failed',
      'menu.delete': 'Delete session',
      'config.toggleTitle': 'Expose session tools to Agents',
      'config.toggleDesc': 'When on, Agents may call session_list / session_delete to browse and delete sessions.',
    }

    const metaStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 13,
      lineHeight: '20px',
      margin: '0 0 10px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }

    const warnStyle = {
      color: 'var(--dsw-alias-state-warn-primary, #f5a524)',
      fontSize: 13,
      lineHeight: '20px',
      margin: '0 0 10px',
    }

    const errStyle = {
      color: 'var(--dsw-alias-state-error-primary, #e5484d)',
      fontSize: 12,
      lineHeight: '16px',
      marginTop: 8,
    }

    const statusStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 12,
      lineHeight: '16px',
      marginTop: 8,
    }

    // Mirror the official Subagent settings page row-for-row: one top-aligned
    // line with the title left and the switch right (16px apart, 13px/1.5),
    // the hint full-width under the line (12px/1.5 tertiary), 6px between the
    // two, 12px vertical padding around the block. The official page builds
    // this with a local CSS module over the shared Switch primitive, so a
    // plugin without a build step replicates it with the same values.
    const toggleBlockStyle = {
      display: 'grid',
      gap: 6,
      padding: '12px 0',
    }

    const toggleRowStyle = {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 16,
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      lineHeight: 1.5,
    }

    const toggleLabelStyle = {
      flex: 1,
      minWidth: 0,
    }

    const toggleDescStyle = {
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 12,
      lineHeight: 1.5,
      margin: 0,
    }

    // --- shared delete flow -------------------------------------------------------

    function deleteSessionViaHost(sessionId) {
      return fetch('/__chameleon/session/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).then(async (res) => {
        let data = {}
        try { data = await res.json() } catch { /* empty body reads as {} */ }
        if (!res.ok || !data.ok) throw new Error(data.error || `delete failed (HTTP ${res.status})`)
      })
    }

    // --- configuration page --------------------------------------------------------
    // A row's page is keyed `<bundle package>#<row id>`, and the bundle that
    // declares this row is the suite this plugin ships in — not the plugin
    // itself. Both shipping shapes are named here: standalone the bundle is this
    // package, inside the suite it is the suite's. A key no row answers to is
    // inert, so naming both costs nothing and needs no inventory round-trip.
    const ROW_CONFIG_KEYS = [
      `${MODULE_NAME}#${ROW_ENTRY_ID}`,
      '@hualiong/dsh-plugin-suite#chameleon-session-delete',
    ]

    // The page is handed the row's own settings namespace by its owner, and a
    // write lands as soon as the switch moves: one control, no separate save.
    function ToggleAgentToolsForm({ t, view, form }) {
      const snapshot = form?.state
      // The row summary falls back here only when the row declares no description.
      if (view === 'summary') return null
      const enabled = snapshot?.value?.exposeAgentTools !== false
      const ready = snapshot?.status === 'ready' && snapshot?.writable === true
      return React.createElement('div', { style: toggleBlockStyle }, [
        React.createElement('div', { key: 'row', style: toggleRowStyle }, [
          React.createElement('span', { key: 'label', style: toggleLabelStyle }, t('config.toggleTitle')),
          React.createElement(Switch, {
            key: 'switch',
            checked: enabled,
            disabled: !ready,
            label: t('config.toggleTitle'),
            onChange: (next) => {
              form.mutate([{ op: 'set', path: ['exposeAgentTools'], value: next }], snapshot.revision)
                .catch(() => { /* a refused write just leaves the switch where it was */ })
            },
          }),
        ]),
        React.createElement('p', { key: 'hint', style: toggleDescStyle }, t('config.toggleDesc')),
      ])
    }

    function apply(ctx) {
      const sessions = ctx.get('sessions')
      const uiWorkspace = ctx.get('uiWorkspace')
      const t = ctx.locale.bind(NS)

      // The single delete request seat: a menu item writes it, the dialog
      // observes and clears it. In-flight and error state die with the request.
      const deleteRequest = createSnapshotStore(null)
      const requestDelete = (sessionId) => deleteRequest.set({ sessionId })
      const settleDelete = () => deleteRequest.set(null)

      const deleteSession = async (sessionId) => {
        // "Current" is the main-view retain, the same signal SessionTree and
        // uiWorkspace use; read it before the row disappears from the list.
        const wasCurrent = (sessions.list.getSnapshot().byId[sessionId]?.retainedBy.mainView ?? 0) > 0
        await deleteSessionViaHost(sessionId)
        sessions.handleSessionRemoved(sessionId)
        // Archive ends in exactly this call: it releases the mainView reference
        // and the persisted selection, so the Conversation falls back to no
        // Session instead of starting a new one.
        if (wasCurrent) uiWorkspace.clearMain()
      }

      ctx.effect(() => ctx.locale.register(NS, { zh: zhDict, en: enDict }))

      const menuInjected = () => ({ requestDelete })
      const dialogInjected = () => ({
        hooks: { deleteRequest },
        sessions,
        deleteSession,
        settleDelete,
      })

      ctx.slots.inject(ITEM_SLOT, () => ctx.slots.register({
        name: ITEM_SLOT,
        id: ROW_ID,
        order: 900,
        locale: NS,
        inject: menuInjected,
      }, DeleteSessionMenuItem))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: DIALOG_ID,
        order: 100,
        locale: NS,
        inject: dialogInjected,
      }, DeleteSessionDialog))

      ctx.effect(() => installMenuOrdering(document))

      // The row page exists only while a `plugins.row.config` entry names the
      // row, so it is registered up front rather than behind an inventory read.
      for (const key of ROW_CONFIG_KEYS) {
        ctx.slots.inject(ROW_CONFIG_SLOT, () => ctx.slots.register({
          name: ROW_CONFIG_SLOT,
          key,
          locale: NS,
        }, ToggleAgentToolsForm))
      }
    }

    // --- menu placement ------------------------------------------------------------

    // The platform renders legacy `sidebar.workspaces.session.menu.item` rows
    // BEFORE the built-in Archive action, and Archive itself lives in the menu
    // footer, so a destructive row registered here lands above it. Nothing in
    // the slot contract can move a row past the footer, so after the menu opens
    // we relocate our own row below Archive. Every step is fail-soft: when the
    // anchors are missing we simply leave the row where the platform put it.
    const DELETE_LABELS = new Set(['删除会话', 'Delete session'])
    const ARCHIVE_LABELS = new Set(['归档会话', '取消归档会话', 'Archive session', 'Unarchive session'])

    /** Trimmed text of one menu row, or '' for anything without text. */
    function rowText(node) {
      return typeof node?.textContent === 'string' ? node.textContent.trim() : ''
    }

    /** One pass over every open menu: put the delete row right after Archive. */
    function moveDeleteBelowArchive(document) {
      let moved = false
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        const items = Array.from(menu.querySelectorAll('[role="menuitem"]'))
        const deleteRow = items.find((node) => DELETE_LABELS.has(rowText(node)))
        const archiveRow = items.find((node) => ARCHIVE_LABELS.has(rowText(node)))
        if (deleteRow === undefined || archiveRow === undefined) continue
        const parent = archiveRow.parentElement
        if (parent === null || parent !== deleteRow.parentElement) continue
        if (deleteRow.previousElementSibling === archiveRow) continue
        parent.insertBefore(deleteRow, archiveRow.nextSibling)
        moved = true
      }
      return moved
    }

    /** Watch menu mounts; returns the disposer. */
    function installMenuOrdering(document) {
      if (document.body === null) return () => {}
      const observer = new MutationObserver(() => {
        moveDeleteBelowArchive(document)
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => observer.disconnect()
    }

    // --- menu item -----------------------------------------------------------------

    function DeleteSessionMenuItem({ sessionId, useMenuOpenState, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return React.createElement(MenuItemButton, {
        danger: true,
        icon: React.createElement(IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false)
          requestDelete(sessionId)
        },
      }, t('menu.delete'))
    }

    // --- dialog ---------------------------------------------------------------------

    function DeleteSessionDialog({ useDeleteRequest, sessions, deleteSession, settleDelete, t }) {
      const request = useDeleteRequest((pending) => pending)
      if (request === null) return null
      return React.createElement(DeleteConfirmForm, {
        key: request.sessionId,
        request,
        sessions,
        deleteSession,
        onSettle: settleDelete,
        t,
      })
    }

    function DeleteConfirmForm({ request, sessions, deleteSession, onSettle, t }) {
      const summary = sessions.list.getSnapshot().byId[request.sessionId]
      const name = summary?.title || summary?.displayTitle || t('dialog.untitled')
      const running = summary?.running === true
      const [deleting, setDeleting] = useState(false)
      const [error, setError] = useState(null)

      const close = useCallback(() => {
        if (deleting) return
        onSettle()
      }, [deleting, onSettle])

      const confirm = useCallback(() => {
        setDeleting(true)
        setError(null)
        deleteSession(request.sessionId).then(() => {
          setDeleting(false)
          onSettle()
        }).catch((reason) => {
          setDeleting(false)
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }, [deleteSession, onSettle, request.sessionId])

      const description = running ? t('dialog.runningDesc') : t('dialog.deleteDesc')

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: t('dialog.title'),
        closeLabel: t('dialog.cancel'),
        description,
        footer: [
          React.createElement(Button, {
            key: 'cancel',
            variant: 'outline',
            disabled: deleting,
            onClick: close,
          }, t('dialog.cancel')),
          React.createElement(Button, {
            key: 'confirm',
            variant: 'primary',
            disabled: deleting,
            onClick: confirm,
          }, deleting ? t('dialog.deleting') : t('dialog.confirm')),
        ],
      }, [
        React.createElement('div', { key: 'meta', style: metaStyle },
          t('dialog.session'), name,
          React.createElement(React.Fragment, null,
            React.createElement('br'),
            t('dialog.sessionId'), request.sessionId)),
        running ? React.createElement('div', { key: 'warn', style: warnStyle }, t('dialog.runningWarn')) : null,
        deleting ? React.createElement('div', { key: 'busy', style: statusStyle }, t('dialog.deleting')) : null,
        error ? React.createElement('div', { key: 'err', style: errStyle, role: 'alert' }, `${t('dialog.failed')}: ${error}`) : null,
      ])
    }

    return { apply, inject: ['slots', 'sessions', 'locale', 'uiWorkspace'] }
  },
})
