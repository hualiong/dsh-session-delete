// dsh-session-delete: CLIENT half.
//
// A sidebar "..." menu item opens one shared delete dialog through a private
// snapshot store (the same menu -> dialog shape ui-workspace uses for rename
// and archive). Deleting calls the host endpoint, then applies the official
// sessions-service removal so the sidebar list updates in place.
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
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const ITEM_SLOT = 'sidebar.workspaces.session.menu.item'
    const ROW_ID = 'dsh-session-delete'
    const OVERLAY_SLOT = 'shell.overlay'
    const DIALOG_ID = 'dsh-session-delete-dialog'

    // --- locale ------------------------------------------------------------------

    const NS = 'dsh-session-delete'

    const zhDict = {
      'dialog.title': '删除会话',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.confirming': '删除中…',
      'dialog.deleting': '正在删除…',
      'dialog.untitled': '未命名会话',
      'dialog.session': '会话：',
      'dialog.sessionId': '序列号：',
      'dialog.runningWarn': '⚠ 会话正在运行',
      'dialog.runningDesc': '该会话正在运行，删除会立即停止其任务并永久删除，正在进行的操作将中断且无法恢复。',
      'dialog.deleteDesc': '将永久删除该会话及其全部对话记录（会话日志、统计与工作区记账），此操作不可恢复。',
      'dialog.failed': '删除失败',
      'menu.delete': '删除会话',
    }

    const enDict = {
      'dialog.title': 'Delete session',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.confirming': 'Deleting…',
      'dialog.deleting': 'Deleting…',
      'dialog.untitled': 'Untitled session',
      'dialog.session': 'Session: ',
      'dialog.sessionId': 'Session ID: ',
      'dialog.runningWarn': '⚠ Session is running',
      'dialog.runningDesc': 'This session is running. Deleting it will stop its task immediately and remove it permanently; any work in progress will be interrupted and cannot be recovered.',
      'dialog.deleteDesc': 'This will permanently delete the session and all of its conversation records (session log, statistics and workspace accounting). This action cannot be undone.',
      'dialog.failed': 'Delete failed',
      'menu.delete': 'Delete session',
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
        // Only deleting the current session navigates: startSession() is the
        // same chain as the "New Session" click and clears the main selection
        // when it cannot reuse or create a workspace session.
        if (wasCurrent && uiWorkspace && typeof uiWorkspace.startSession === 'function') {
          uiWorkspace.startSession()
        }
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
          }, deleting ? t('dialog.confirming') : t('dialog.confirm')),
        ],
      }, [
        React.createElement('div', { key: 'meta', style: metaStyle },
          t('dialog.session'), name,
          React.createElement(React.Fragment, null,
            React.createElement('br'),
            t('dialog.sessionId'), request.sessionId)),
        running ? React.createElement('div', { key: 'warn', style: warnStyle }, t('dialog.runningWarn')) : null,
        deleting ? React.createElement('div', { key: 'busy', style: statusStyle }, t('dialog.deleting')) : null,
        error ? React.createElement('div', { key: 'err', style: errStyle, role: 'alert' }, `${t('dialog.failed')}：${error}`) : null,
      ])
    }

    return { apply, inject: ['slots', 'sessions', 'locale', 'uiWorkspace'] }
  },
})
