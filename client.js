/**
 * Browser half of dsh-pocket-console.
 *
 * Registers one card under `settings.plugin.item` keyed by this plugin's
 * settings namespace, which is the documented way a plugin distributed outside
 * the DSH repository contributes a Settings → Plugins card. The tab decides only
 * which namespaces to dispatch, so this card owns its chrome and follows the
 * tokens and layout the shipped cards use.
 *
 * Editable values are staged here and written through `ctx.settingsScope`,
 * which fences each write with the revision the card read. The binding state
 * machine is not a settings value: the Host half owns it behind `/__pocket/*` on
 * the same webserver, so the card polls its own routes and needs no Remote
 * method.
 *
 * Hand-written in the client module system's factory format, so the package
 * ships and installs with no build step. `require` is the shell's module table;
 * only its baseline modules may be requested.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pocket-console',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports

    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement
    const { IconChevronDownOutline14, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Settings namespace; also the `settings.plugin.item` slot key. */
    const NS = 'pocket-console'

    /** Same-origin route prefix the host half registers. */
    const ROUTE = '/__pocket'

    /** Section fields this card edits, in render order. */
    const FIELDS = [
      { field: 'delaySeconds', kind: 'number' },
      { field: 'titlePrefix', kind: 'text' },
      { field: 'resultNotify', kind: 'select', options: ['off', 'idle'], labels: { off: 'resultNotifyOff', idle: 'resultNotifyIdle' } },
    ]

    /** The colour each enrollment state reports itself in. */
    const STATUS_COLORS = {
      success: 'var(--dsw-alias-state-success-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      info: 'var(--dsw-alias-brand-primary)',
      muted: 'var(--dsw-alias-label-tertiary)',
    }

    /**
     * The tone each enrollment state is shown in. `bound` is green only once
     * the connection reports itself ready; until then the card is still trying.
     */
    const STATUS_TONE = {
      unbound: 'muted',
      awaiting: 'info',
      starting: 'warn',
      bound: 'success',
      failed: 'danger',
      unsupported: 'muted',
    }

    const COPY = {
      zh: {
        title: '口袋控制台',
        description: '把工具审批与提问送到手机，桌面始终优先。',
        bound: '已绑定',
        unbound: '未绑定',
        awaiting: '等待扫码确认',
        startingConnecting: '正在连接飞书…',
        startingConnectingSlow: '仍在连接飞书…（网络可能不通，会继续重试）',
        startingCreating: '正在创建飞书应用…二维码马上出现',
        startingCreatingSlow: '创建应用比平时慢…仍在等待飞书返回二维码',
        failed: '连接失败',
        unsupported: '当前通道不支持绑定',
        appId: '应用',
        unknown: '未知',
        recipient: '接收人',
        recipientNone: '未绑定 —— 在飞书里给这个机器人发一条消息即可绑定',
        connection: '长连接',
        connected: '已建立',
        reconnecting: '已断开，正在重连…',
        persistFailed: '已连接，但这组凭据没能保存（重启后需要重新填写）。',
        guideFirst: '· 第一次用：点「扫码创建应用」，权限由这个流程自动配好。',
        guideReturning: '· 之前创建过：点「使用已有的应用」，填那个应用的 App ID 与 App Secret；权限已经配好，不用再授权。',
        pending: '待审批',
        pendingApproval: '工具审批',
        pendingQuestion: '提问',
        pendingDelivered: '已送达手机',
        pendingWaiting: '等待桌面',
        scan: '用飞书扫描下面的二维码完成绑定。链接 10 分钟内有效，仅可使用一次。',
        bind: '扫码创建应用',
        bindExisting: '使用已有的应用',
        bindExistingHint: '填之前创建过的那个应用的 App ID 与 App Secret（在飞书开发者后台的「凭证与基础信息」里）。插件直接用它连接：不扫码，也不改动这个应用的任何设置。',
        changeApp: '使用其他应用',
        appIdLabel: 'App ID',
        appIdPlaceholder: 'cli_xxxxxxxx',
        appSecretLabel: 'App Secret',
        appSecretPlaceholder: '应用密钥',
        connect: '连接',
        unbind: '解除绑定',
        cancel: '取消',
        close: '关闭',
        unbindConfirm: '解除后手机上不再收到审批，确定吗？',
        retry: '重试',
        open: '在手机上打开这个链接',
        copy: '复制链接',
        copied: '已复制',
        loading: '读取中…',
        hostOutdated: '宿主还在运行旧版插件，没有这条接口：请重启 dsh web 后再试（只刷新页面不会更新宿主）。',
        delaySeconds: '桌面专享时间（秒）',
        delaySecondsHint: '桌面在这段时间内可以先答；超时后同一条请求才会发到手机。0 表示同时可答。',
        titlePrefix: '标题前缀',
        titlePrefixHint: '手机消息标题的前缀，用来区分不同部署。',
        resultNotify: '结果通知',
        resultNotifyHint: '会话停下来后，把本轮结果发到手机，并附上一个可以直接回复的输入框。',
        resultNotifyOff: '关闭',
        resultNotifyIdle: '空闲时通知',
        overridden: '已覆盖',
        reset: '恢复默认',
        invalidNumber: '请填一个数字，留空表示恢复默认。',
        unsaved: '未保存',
        save: '保存',
        saving: '保存中…',
        discard: '放弃修改',
        saveFailed: '保存没有生效，请检查后重试。',
        readOnly: '当前设置文档只读，修改无法保存。',
        expand: '展开',
        collapse: '收起',
      },
      en: {
        title: 'Pocket console',
        description: 'Send tool approvals and questions to your phone, with the desktop always first in line.',
        bound: 'Bound',
        unbound: 'Not bound',
        awaiting: 'Waiting for confirmation',
        startingConnecting: 'Connecting to Feishu…',
        startingConnectingSlow: 'Still connecting to Feishu… (the network may be blocked; retrying)',
        startingCreating: 'Creating the Feishu app… the QR code is on its way',
        startingCreatingSlow: 'Creating the app is taking longer than usual… still waiting for the QR code',
        failed: 'Connection failed',
        unsupported: 'This channel does not support binding',
        appId: 'App',
        unknown: 'unknown',
        recipient: 'Recipient',
        recipientNone: 'not bound yet — send this bot a message in Feishu to bind',
        connection: 'Connection',
        connected: 'established',
        reconnecting: 'dropped; reconnecting…',
        persistFailed: 'Connected, but these credentials could not be saved (they must be entered again after a restart).',
        guideFirst: '· First time: use "Scan to create an app" — that flow configures the permissions for you.',
        guideReturning: '· Created one before: use "Use an existing app" and enter its App ID and App Secret; the permissions are already set, so nothing has to be authorized again.',
        pending: 'Pending',
        pendingApproval: 'Tool approval',
        pendingQuestion: 'Question',
        pendingDelivered: 'sent to the phone',
        pendingWaiting: 'waiting on the desktop',
        scan: 'Scan this code with Feishu to finish binding. The link is valid for 10 minutes and can be used once.',
        bind: 'Scan to create an app',
        bindExisting: 'Use an existing app',
        bindExistingHint: 'Enter the App ID and App Secret of the app you created before, from the developer console under Credentials & Basic Info. The plugin connects with them directly: no scan, and nothing about that app is changed.',
        changeApp: 'Use another app',
        appIdLabel: 'App ID',
        appIdPlaceholder: 'cli_xxxxxxxx',
        appSecretLabel: 'App Secret',
        appSecretPlaceholder: 'App secret',
        connect: 'Connect',
        unbind: 'Unbind',
        cancel: 'Cancel',
        close: 'Close',
        unbindConfirm: 'Approvals will stop reaching your phone. Continue?',
        retry: 'Retry',
        open: 'Open this link on your phone',
        copy: 'Copy link',
        copied: 'Copied',
        loading: 'Loading…',
        hostOutdated: 'The host is still running an older version of this plugin, which does not have this route: restart dsh web and try again. Reloading the page alone does not update the host.',
        delaySeconds: 'Desktop head start (seconds)',
        delaySecondsHint: 'Seconds the desktop may answer before the same request is sent to the phone. 0 makes both answerable at once.',
        titlePrefix: 'Title prefix',
        titlePrefixHint: 'Prefix on every phone message title, for telling deployments apart.',
        resultNotify: 'Result notices',
        resultNotifyHint: 'After a session stops, send the turn result to the phone with a box to reply in.',
        resultNotifyOff: 'Off',
        resultNotifyIdle: 'When idle',
        overridden: 'Overridden',
        reset: 'Reset',
        invalidNumber: 'Enter a number, or leave it blank to inherit the default.',
        unsaved: 'Unsaved',
        save: 'Save',
        saving: 'Saving…',
        discard: 'Discard',
        saveFailed: 'The save did not take effect. Check the values and try again.',
        readOnly: 'This settings document is read-only, so changes cannot be saved.',
        expand: 'Expand',
        collapse: 'Collapse',
      },
    }

    /**
     * Copy for the language the shell published. The locale plugin owns the
     * `<html lang>` attribute, so reading it keeps this card out of a second
     * language registry.
     * @returns the copy table for the active document language.
     */
    function copyForDocument() {
      const lang = typeof document === 'undefined' ? '' : String(document.documentElement?.lang ?? '')
      return lang.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
    }

    /** Inline styles: the shipped cards' tokens and metrics, which this bundle cannot import. */
    const S = {
      card: (open) => ({
        listStyle: 'none',
        border: `1px solid var(--dsw-alias-${open ? 'label-dimmed' : 'border-l2'})`,
        borderRadius: '12px',
        background: `var(--dsw-alias-bg-layer-${open ? 2 : 3})`,
      }),
      header: {
        width: '100%', appearance: 'none', border: 0, background: 'none', font: 'inherit',
        color: 'inherit', textAlign: 'left', cursor: 'pointer', display: 'flex',
        alignItems: 'center', gap: '12px', padding: '14px 16px', borderRadius: '12px',
      },
      headText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
      name: { fontSize: '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' },
      description: { fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      chevron: (open) => ({
        // The icon takes only size and className: it fills with currentColor, so
        // the wrapper owns colour and rotation, and inline-flex is what lets the
        // transform apply at all.
        display: 'inline-flex', flex: 'none',
        color: 'var(--dsw-alias-label-tertiary)', transition: 'transform .16s',
        ...(open ? { transform: 'rotate(180deg)' } : {}),
      }),
      badge: {
        flex: 'none', borderRadius: '999px', padding: '1px 8px', fontSize: '11px', lineHeight: '17px',
        fontWeight: 500, whiteSpace: 'nowrap', background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      body: { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: '8px' },
      section: {
        display: 'flex', flexDirection: 'column', gap: '8px',
        padding: '12px 0', borderTop: '1px solid var(--dsw-alias-border-l2)',
      },
      scanBlock: { display: 'flex', flexDirection: 'column', gap: '8px' },
      status: (tone) => ({ display: 'inline-flex', alignItems: 'center', gap: '6px', color: STATUS_COLORS[tone] }),
      dot: (tone) => ({
        width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: STATUS_COLORS[tone],
      }),
      guide: {
        display: 'flex', flexDirection: 'column', gap: '4px',
        fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)',
      },
      warn: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-warn-primary)' },
      notice: { margin: '12px 0 0', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', gap: '8px', alignItems: 'baseline' },
      rowLabel: { color: 'var(--dsw-alias-label-tertiary)', minWidth: '8rem' },
      list: { margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' },
      listItem: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      field: {
        display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0',
        borderTop: '1px solid var(--dsw-alias-border-l2)',
      },
      fieldHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: { flex: 1, minWidth: 0, fontSize: '13px', fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
      badges: { display: 'inline-flex', alignItems: 'center', gap: '8px' },
      reset: {
        border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: '12px',
        lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
      },
      input: {
        height: '34px', padding: '0 12px', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit',
        fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)',
      },
      inputInvalid: { borderColor: 'var(--dsw-alias-label-error)' },
      invalid: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' },
      hint: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      footer: {
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px',
        padding: '12px 0 4px', borderTop: '1px solid var(--dsw-alias-border-l2)',
      },
      failed: { flex: 1, minWidth: 0, margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-error)' },
      secondary: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
        padding: '5px 14px', font: 'inherit', fontSize: '13px', lineHeight: 1.5, cursor: 'pointer',
        background: 'none', color: 'var(--dsw-alias-label-secondary)',
      },
      primary: {
        appearance: 'none', border: '1px solid transparent', borderRadius: '8px', padding: '5px 14px',
        font: 'inherit', fontSize: '13px', lineHeight: 1.5, cursor: 'pointer',
        background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)',
      },
      disabled: { opacity: 0.4, cursor: 'default' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      qr: {
        background: 'var(--dsw-alias-bg-layer-3)', padding: '8px', borderRadius: '8px',
        alignSelf: 'flex-start', width: 240, height: 240,
      },
      link: { color: 'var(--dsw-alias-brand-primary)' },
      error: { color: 'var(--dsw-alias-label-error)' },
    }

    /** A button whose disabled look matches the shipped cards. */
    const button = (label, onClick, options = {}) => h('button', {
      type: 'button',
      style: { ...(options.primary ? S.primary : S.secondary), ...(options.disabled ? S.disabled : {}) },
      disabled: options.disabled === true,
      onClick,
    }, label)

    /** Render a stored value as draft text; a section carrying none renders empty. */
    const formatValue = value => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

    /**
     * The write one draft stages, or undefined when the draft is not a value the
     * field accepts — which blocks the save instead of discarding the edit.
     * @param kind - `number` or `text`.
     * @param text - draft text.
     * @returns the staged write, or undefined when invalid.
     */
    function parseValue(kind, text) {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (kind !== 'number') return { kind: 'set', value: trimmed }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    }

    /**
     * Stage edits over the settings namespace and write them on save.
     *
     * A write is a durable, revision-fenced document mutation, so a control that
     * committed as it settled would write something the user never asked for and
     * could not preview. Each field shows its effective value — user layer over
     * composition layer over schema default — and whether the user layer carries
     * it: that presence, not a value comparison, is what marks it overridden.
     * @param scope - the bound settings scope for this card's namespace.
     * @returns the projection and the actions the card renders and calls.
     */
    function createSettingsForm(scope) {
      const staged = new Map()
      const listeners = new Set()
      let saving = false
      let failed = false

      const snapshotOf = () => scope.getSnapshot()
      const sectionValue = field => snapshotOf().value?.[field]
      const baseValue = field => snapshotOf().base?.[field]
      const userLayer = () => {
        const user = snapshotOf().user
        return user !== null && typeof user === 'object' ? user : undefined
      }
      const stored = field => userLayer() !== undefined && Object.hasOwn(userLayer(), field)
      const specOf = field => FIELDS.find(spec => spec.field === field)
      const publish = () => { for (const listener of listeners) listener() }

      /** Every staged edit a save would write; an invalid draft carries none. */
      const plan = () => {
        const items = []
        for (const [field, edit] of staged) {
          const spec = specOf(field)
          if (spec === undefined) continue
          if (edit.clear) {
            if (stored(field)) items.push({ run: () => clear(field) })
            continue
          }
          if (edit.text === formatValue(sectionValue(field))) continue
          const write = parseValue(spec.kind, edit.text)
          if (write === undefined) items.push({ run: undefined })
          else if (write.kind === 'clear') items.push({ run: () => clear(field) })
          else items.push({ run: () => store(field, write.value) })
        }
        return items
      }

      const clear = async (field) => {
        await scope.unset(field)
        return !stored(field)
      }

      const store = async (field, value) => {
        await scope.set(field, value)
        return userLayer()?.[field] === value
      }

      /** One control's state. */
      const fieldState = (field) => {
        const spec = specOf(field)
        const edit = staged.get(field)
        if (edit === undefined) {
          return { text: formatValue(sectionValue(field)), overridden: stored(field), invalid: false }
        }
        const write = edit.clear ? { kind: 'clear' } : parseValue(spec.kind, edit.text)
        return { text: edit.text, overridden: write?.kind === 'set', invalid: write === undefined }
      }

      /** Form-level state: what the Host serves, and what a save would do. */
      const shell = () => ({
        available: snapshotOf().status === 'ready',
        writable: snapshotOf().writable,
        dirty: plan().length > 0,
        invalid: plan().some(item => item.run === undefined),
        saving,
        failed,
      })

      scope.subscribe(publish)

      return {
        projection: () => ({
          shell: shell(),
          delaySeconds: fieldState('delaySeconds'),
          titlePrefix: fieldState('titlePrefix'),
          resultNotify: fieldState('resultNotify'),
        }),
        edit(field, text) { staged.set(field, { text, clear: false }); failed = false; publish() },
        resetField(field) {
          staged.set(field, { text: formatValue(baseValue(field)), clear: true })
          failed = false
          publish()
        },
        discard() {
          if (staged.size === 0 && !failed) return
          staged.clear()
          failed = false
          publish()
        },
        async save() {
          const items = plan()
          const writes = items.flatMap(item => item.run === undefined ? [] : [item.run])
          if (items.length === 0 || saving || writes.length !== items.length) return
          saving = true
          failed = false
          publish()
          let landed = true
          for (const write of writes) landed = await write() && landed
          if (landed) staged.clear()
          saving = false
          failed = !landed
          publish()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /**
     * A bare observable snapshot: what the slot system's reserved `hooks`
     * compartment carries, and what the renderer binds as `use<Name>`.
     *
     * Written here rather than imported. The shell seeds a fixed module table,
     * and which package owns a store engine is not part of that contract: one
     * release keeps it in the client runtime, the next moves it to a client
     * store package. Requesting the wrong one fails the whole bundle import and
     * takes the page's boot with it. React never sees this object — the
     * renderer subscribes to it.
     * @param initial - the first snapshot.
     * @returns the source, plus the mutation its registrant owns.
     */
    function createSnapshot(initial) {
      let current = initial
      const listeners = new Set()
      return {
        getSnapshot: () => current,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          current = next
          for (const listener of listeners) listener()
        },
      }
    }

    /**
     * Render one plugin card.
     * @param props - copy, the form snapshot bound from the hooks compartment, and the form actions.
     * @returns the card, or nothing when the Host does not serve its namespace.
     */
    function PocketConsoleCard(props) {
      const copy = props.copy
      const state = props.usePocketConsole(snapshot => snapshot)
      const shell = state.shell
      const [open, setOpen] = useState(false)
      const [runtime, setRuntime] = useState(null)
      const [failure, setFailure] = useState(null)
      const [busy, setBusy] = useState(false)
      const [copied, setCopied] = useState(false)
      const [confirmingUnbind, setConfirmingUnbind] = useState(false)
      const [askingAppId, setAskingAppId] = useState(false)
      const [existing, setExisting] = useState({ appId: '', appSecret: '' })

      const refresh = useCallback(async (signal) => {
        try {
          const response = await fetch(`${ROUTE}/state`, { signal, headers: { accept: 'application/json' } })
          // The page and the process that serves it are replaced separately, so a
          // 404 here means this page is newer than the host it is talking to.
          if (response.status === 404) throw new Error(copy.hostOutdated)
          if (!response.ok) throw new Error(`state request failed: ${response.status}`)
          setRuntime(await response.json())
          setFailure(null)
        } catch (error) {
          if (error?.name === 'AbortError') return
          setFailure(String(error?.message ?? error))
        }
      }, [copy.hostOutdated])

      /** Run one binding operation, then adopt the enrollment it reports. */
      const run = async (path, body) => {
        setBusy(true)
        try {
          const response = await fetch(`${ROUTE}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          })
          if (response.status === 404) throw new Error(copy.hostOutdated)
          if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
          const enrollment = await response.json()
          setRuntime(previous => ({ ...previous, enrollment }))
          setFailure(null)
        } catch (error) {
          setFailure(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const enrollment = runtime?.enrollment ?? { state: 'unbound' }
      const settings = runtime?.settings ?? {}
      const pending = Array.isArray(runtime?.pending) ? runtime.pending : []
      const verifyUrl = enrollment.verifyUrl
      const tone = STATUS_TONE[enrollment.state] ?? 'muted'
      // Which wait this is, and whether it has gone on unusually long: the two are
      // told apart because "creating the app" and "connecting to it" fail, stall,
      // and finish differently, and a reader can act on knowing which one it is.
      const stage = enrollment.stage === 'creating' ? 'creating' : 'connecting'
      const STARTING = {
        creating: { normal: copy.startingCreating, slow: copy.startingCreatingSlow },
        connecting: { normal: copy.startingConnecting, slow: copy.startingConnectingSlow },
      }
      const status = enrollment.state === 'starting'
        ? STARTING[stage][enrollment.slow === true ? 'slow' : 'normal']
        : copy[enrollment.state] ?? copy.unbound
      const recipientValue = enrollment.recipient === null || enrollment.recipient === undefined
        ? h('span', null, copy.recipientNone)
        : h('code', null, enrollment.recipient)

      useEffect(() => {
        const controller = new AbortController()
        void refresh(controller.signal)
        // Binding and connecting both settle out of band, so the card polls. An
        // attempt that is still running is asked more often than an idle card, so
        // a verdict arrives in about a second instead of at the next idle tick.
        const settling = enrollment.state === 'starting' || enrollment.state === 'awaiting'
        const timer = setInterval(() => { void refresh(controller.signal) }, settling ? 700 : 3000)
        return () => {
          controller.abort()
          clearInterval(timer)
        }
      }, [refresh, enrollment.state])

      // A deployment that never composed the Host half shows no trace of the card.
      if (!shell.available) return null

      /** One labelled row of the status block. */
      const row = (key, label, value) => h('div', { key, style: S.row },
        h('span', { style: S.rowLabel }, label), value)

      const field = (fieldSpec, label, hint) => {
        const control = state[fieldSpec.field]
        const id = `pocket-console-${fieldSpec.field}`
        return h('div', { key: fieldSpec.field, style: S.field },
          h('div', { style: S.fieldHead },
            h('label', { style: S.label, htmlFor: id }, label),
            h('span', { style: S.badges },
              control.overridden ? h('span', { style: S.badge }, copy.overridden) : null,
              button(copy.reset, () => { props.resetField(fieldSpec.field) },
                { disabled: !control.overridden || !shell.writable }))),
          fieldSpec.kind === 'select'
            ? h('select', {
                id,
                style: S.input,
                value: control.text,
                disabled: !shell.writable,
                onChange: event => { props.edit(fieldSpec.field, event.target.value) },
              }, fieldSpec.options.map(option => h('option', { key: option, value: option },
                copy[fieldSpec.labels?.[option] ?? option])))
            : h('input', {
                id,
                style: control.invalid ? { ...S.input, ...S.inputInvalid } : S.input,
                value: control.text,
                disabled: !shell.writable,
                inputMode: fieldSpec.kind === 'number' ? 'numeric' : undefined,
                onChange: event => { props.edit(fieldSpec.field, event.target.value) },
              }),
          control.invalid ? h('p', { style: S.invalid }, copy.invalidNumber) : null,
          h('p', { style: S.hint }, hint))
      }

      /** The binding half of the card: enrollment, what is open, and its controls. */
      const runtimeRows = runtime === null
        ? [h('div', { key: 'loading', style: S.notice }, copy.loading)]
        : [
            h('div', { key: 'status', style: S.row },
              h('span', { style: S.rowLabel }, copy.title),
              h('span', { style: S.status(tone) },
                h('span', { style: S.dot(tone), 'aria-hidden': 'true' }),
                status)),
            // Which app this deployment is actually connected as, and whether it
            // is up: the two facts a reader needs to tell success from silence.
            enrollment.state === 'bound' ? row('app', copy.appId, h('code', null, enrollment.appId ?? copy.unknown)) : null,
            enrollment.state === 'bound' ? row('recipient', copy.recipient, recipientValue) : null,
            enrollment.state === 'bound'
              ? row('connection', copy.connection,
                  h('span', null, enrollment.connected === true ? copy.connected : copy.reconnecting))
              : null,
            enrollment.state === 'bound' && enrollment.persisted === false
              ? h('div', { key: 'persist-warning', style: S.warn }, copy.persistFailed)
              : null,
            h('div', { key: 'pending', style: S.row },
              h('span', { style: S.rowLabel }, copy.pending),
              h('span', null, String(pending.length))),
            pending.length > 0
              ? h('ul', { key: 'pending-list', style: S.list }, pending.map((entry, index) => h('li', { key: index, style: S.listItem },
                  `· ${entry.kind === 'approval' ? copy.pendingApproval : copy.pendingQuestion} ${entry.summary}（${entry.delivered ? copy.pendingDelivered : copy.pendingWaiting}）`)))
              : null,
            verifyUrl !== undefined && enrollment.state === 'awaiting'
              ? h('div', { key: 'scan', style: S.scanBlock },
                  h('div', { style: S.description }, copy.scan),
                  h('img', { src: `${ROUTE}/qr.svg`, alt: copy.open, style: S.qr }),
                  h('div', { style: { ...S.actions, alignItems: 'center' } },
                    h('a', { href: verifyUrl, target: '_blank', rel: 'noreferrer', style: S.link }, copy.open),
                    button(copied ? copy.copied : copy.copy, () => {
                      void navigator.clipboard?.writeText(verifyUrl).then(() => {
                        setCopied(true)
                        setTimeout(() => { setCopied(false) }, 2000)
                      })
                    })))
              : null,
            enrollment.state === 'failed' && enrollment.message !== undefined
              ? h('div', { key: 'enrollment-failure', style: S.error }, enrollment.message)
              : null,
            // Which of the two ways to bind is the right one depends on whether
            // the reader has scanned before, and only the copy can say so.
            enrollment.state === 'unbound' || enrollment.state === 'failed'
              ? h('div', { key: 'guide', style: S.guide },
                  h('div', null, copy.guideFirst),
                  h('div', null, copy.guideReturning))
              : null,
            failure !== null ? h('div', { key: 'failure', style: S.error }, failure) : null,
            h('div', { key: 'binding-actions', style: S.actions },
              // Binding is one decision with two answers: create an app, or point
              // the same flow at one that already exists. Re-binding was a third
              // button that did exactly what the first one does — the channel
              // reconnects from stored credentials on its own at every load.
              enrollment.state === 'bound'
                ? [
                    button(copy.changeApp, () => { setAskingAppId(true) }, { disabled: busy }),
                    button(copy.unbind, () => { setConfirmingUnbind(true) }, { disabled: busy }),
                  ]
                // A connection that is being established is the only state with
                // nothing to press: a second attempt would abandon the one that
                // is running. A scan that is waiting still offers the other way
                // round, and every failed attempt can be retried.
                : enrollment.state === 'starting'
                  ? null
                  : [
                      button(copy.bind, () => { void run('/bind', { mode: 'create' }) }, { disabled: busy, primary: true }),
                      button(copy.bindExisting, () => { setAskingAppId(true) }, { disabled: busy }),
                    ]),
            // The GUI's own dialog, not the browser's: same chrome, same keyboard
            // handling, and it belongs to the page the reader is already in.
            // Binding an existing app asks which one first: the launch page only
            // learns the app from the id it is carried with.
            h(Modal, {
              key: 'bind-existing',
              open: askingAppId,
              onClose: () => { setAskingAppId(false) },
              title: copy.bindExisting,
              closeLabel: copy.close,
              description: copy.bindExistingHint,
              footer: [
                button(copy.cancel, () => { setAskingAppId(false) }, { disabled: busy }),
                button(copy.connect, () => {
                  setAskingAppId(false)
                  // The secret lives in the form only until it has been handed
                  // over; a failure is reported by the channel, which is where
                  // the reason comes from.
                  void run('/adopt', { appId: existing.appId.trim(), appSecret: existing.appSecret.trim() })
                    .then(() => { setExisting({ appId: '', appSecret: '' }) })
                }, {
                  disabled: busy || existing.appId.trim() === '' || existing.appSecret.trim() === '',
                  primary: true,
                }),
              ],
            }, [
              h('div', { key: 'app-id-field', style: S.field },
                h('label', { style: S.label, htmlFor: 'pocket-console-app-id' }, copy.appIdLabel),
                h('input', {
                  id: 'pocket-console-app-id',
                  style: S.input,
                  value: existing.appId,
                  placeholder: copy.appIdPlaceholder,
                  onChange: event => { setExisting(current => ({ ...current, appId: event.target.value })) },
                })),
              h('div', { key: 'app-secret-field', style: S.field },
                h('label', { style: S.label, htmlFor: 'pocket-console-app-secret' }, copy.appSecretLabel),
                h('input', {
                  id: 'pocket-console-app-secret',
                  style: S.input,
                  type: 'password',
                  value: existing.appSecret,
                  placeholder: copy.appSecretPlaceholder,
                  onChange: event => { setExisting(current => ({ ...current, appSecret: event.target.value })) },
                })),
            ]),
            h(Modal, {
              key: 'unbind-confirm',
              open: confirmingUnbind,
              onClose: () => { setConfirmingUnbind(false) },
              title: copy.unbind,
              closeLabel: copy.close,
              description: copy.unbindConfirm,
              footer: [
                button(copy.cancel, () => { setConfirmingUnbind(false) }, { disabled: busy }),
                button(copy.unbind, () => {
                  setConfirmingUnbind(false)
                  void run('/unbind')
                }, { disabled: busy, primary: true }),
              ],
            }),
          ]

      const blocked = !shell.dirty || shell.invalid || shell.saving
      return h('li', { style: S.card(open) },
        h('button', {
          type: 'button',
          style: S.header,
          'aria-expanded': open,
          'aria-label': `${copy[open ? 'collapse' : 'expand']}: ${copy.title}`,
          onClick: () => { setOpen(!open) },
        },
          h('span', { style: S.headText },
            h('span', { style: S.name }, copy.title),
            h('span', { style: S.description }, copy.description)),
          shell.dirty ? h('span', { style: S.badge }, copy.unsaved) : null,
          h('span', { style: S.chevron(open) }, h(IconChevronDownOutline14, {}))),

        open ? h('div', { style: S.body },
          !shell.writable ? h('p', { style: S.notice, role: 'status' }, copy.readOnly) : null,

          h('div', { style: S.section }, runtimeRows),

          // Derived from FIELDS, never indexed: a label and its control are the
          // same spec by construction, which is the one thing a positional list
          // got wrong the moment a field was inserted in the middle.
          ...FIELDS.map(spec => field(spec, copy[spec.field], copy[`${spec.field}Hint`])),

          h('div', { style: S.footer },
            shell.failed ? h('p', { style: S.failed, role: 'status' }, copy.saveFailed) : null,
            button(copy.discard, props.discard, { disabled: !shell.dirty || shell.saving }),
            button(shell.saving ? copy.saving : copy.save, props.save, { disabled: blocked, primary: true })))
          : null)
    }

    /**
     * Register the card under this plugin's settings namespace.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS })
      const form = createSettingsForm(scope)
      const store = createSnapshot(form.projection())
      form.subscribe(() => { store.set(form.projection()) })
      const copy = copyForDocument()

      /**
       * Mirror one answer the phone already gave onto this page's composer.
       *
       * The Host cannot withdraw a forwarded request: the gateway finishes one
       * only when a browser answers it, so a request answered on the phone leaves
       * this composer waiting. Applying the same answer here runs the very call a
       * click runs, so the request settles, the composer closes, and the choice is
       * on screen exactly as if it had been made here.
       * @param sync - the phone's accepted decision, as the Host recorded it.
       * @returns null when it was applied, else why it could not be.
       */
      const applySync = (sync) => {
        if (sync === null || typeof sync !== 'object') return 'no decision'
        // Read through `get`: the browser half still works where the Session UI
        // is absent, and reading a service property without an `inject` throws.
        const snapshot = ctx.get?.('uiSession')?.pendingInteractions?.getSnapshot?.()
        if (snapshot?.get === undefined) return 'no pending-interaction source'
        const ids = Array.isArray(sync.questions) ? sync.questions.join('\u0000') : undefined
        const matches = pending => ids === undefined || ids === ''
          || (pending?.questions ?? []).map(item => item?.id).join('\u0000') === ids
        // Only the request the phone actually decided: another request in the
        // same session may be pending by the time this poll arrives. The session
        // the Host named is tried first; with it unnamed or keyed differently the
        // question ids decide, since both sides read them from one request.
        const named = sync.sessionId === undefined ? undefined : snapshot.get(sync.sessionId)
        const pending = matches(named) ? named : [...snapshot.values()].find(entry => matches(entry))
        if (pending === undefined || typeof pending.answer !== 'function') return 'no waiting composer'
        // A composer that already settled is not a failure — the recorded answer
        // is the phone's either way, and there is nothing left to mirror.
        void Promise.resolve(pending.answer(sync.answer)).catch(() => {})
        return null
      }

      /**
       * The interface language, as the shell publishes it on <html>.
       * @returns a known locale, or undefined when the page names none.
       */
      function documentLanguage() {
        const tag = globalThis.document?.documentElement?.lang
        if (typeof tag !== 'string' || tag === '') return undefined
        const base = tag.toLowerCase().split('-')[0]
        return base === 'zh' || base === 'en' ? base : undefined
      }

      /** Read the Host's last phone decision, or null when it offers none. */
      const readSync = async () => {
        const response = await fetch(`${ROUTE}/state`, { headers: { accept: 'application/json' } })
        return response.ok ? ((await response.json())?.sync ?? null) : null
      }

      /**
       * Tell the Host what the mirror did. The composer belongs to the browser, so
       * this is the only place the Host — and the deployment log — can see whether
       * a decision taken on the phone actually landed here.
       * @param status - mounted, applied, skipped, or error.
       * @param reason - why it could not be applied, when it could not.
       * @param syncId - the decision this report is about, when there is one.
       */
      const report = (status, reason, syncId) => {
        void fetch(`${ROUTE}/mirror`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            status,
            // The Host has no other way to know which language this reader is
            // reading, and the phone card should not disagree with the page.
            ...(documentLanguage() === undefined ? {} : { lang: documentLanguage() }),
            ...(reason === undefined ? {} : { reason }),
            ...(syncId === undefined ? {} : { syncId }),
          }),
        }).catch(() => {})
      }

      /**
       * Poll the Host for a phone decision and mirror it.
       *
       * This runs from the plugin body rather than from a component: the composer
       * it has to close can be showing while no conversation outlet of ours
       * renders, and a mirror that only works when a slot happens to be mounted is
       * not a mirror.
       */
      const startMirror = () => {
        let stopped = false
        let applied = null
        let reported = null
        const poll = async () => {
          try {
            const sync = await readSync()
            if (stopped || sync === null || sync.id === applied) return
            const reason = applySync(sync)
            if (reason === null) {
              applied = sync.id
              console.info(`pocket-console: mirrored the phone's ${String(sync.kind)} decision`)
              report('applied', undefined, sync.id)
              return
            }
            if (reported !== sync.id) {
              reported = sync.id
              console.info(`pocket-console: mirror skipped — ${reason}`)
              report('skipped', reason, sync.id)
            }
          } catch (error) {
            // A failed poll mirrors nothing and retries on the next tick: the
            // phone's answer is already recorded either way.
            const message = String(error?.message ?? error)
            console.info(`pocket-console: mirror poll failed — ${message}`)
            report('error', message)
          }
        }
        void poll()
        const timer = setInterval(() => { void poll() }, 1000)
        // A browser timer has no unref; the suite runs this bundle under Node,
        // where keeping the process alive for a poll would hang it.
        timer.unref?.()
        return () => { stopped = true; clearInterval(timer) }
      }

      /**
       * Report whether a composer is on screen.
       *
       * The panel renders from the Session UI's pending-interaction snapshot, so
       * that snapshot's transitions are the only direct observation of the panel
       * itself: nothing on the Host can see whether a browser is showing one.
       * The snapshot holds one entry per session, and each is its own transition,
       * so a panel opening in a second session is reported even while one is
       * already showing.
       * @returns a disposer removing the subscription.
       */
      const watchPanel = () => {
        const source = ctx.get?.('uiSession')?.pendingInteractions
        if (typeof source?.subscribe !== 'function') {
          report('panel-unknown', 'no pending-interaction source')
          return () => {}
        }
        let last = null
        const announce = () => {
          const pending = source.getSnapshot?.()
          const entries = pending === undefined ? [] : [...pending.entries()]
          const state = entries
            .map(([id, entry]) => `${String(id)}:${String(entry?.kind ?? 'unknown')}`)
            .sort()
            .join(',')
          if (state === last) return
          last = state
          if (entries.length === 0) {
            report('panel-closed')
            return
          }
          // The session's tail names which panel moved, so a report can be read
          // without printing a whole session id.
          report('panel-open', entries
            .map(([id, entry]) => `${String(entry?.kind ?? 'unknown')}#${String(id).slice(-4)}`)
            .join(' '))
        }
        announce()
        const off = source.subscribe(announce)
        return typeof off === 'function' ? off : () => {}
      }

      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        inject: () => ({
          copy,
          hooks: { pocketConsole: store },
          edit: form.edit,
          resetField: form.resetField,
          save: form.save,
          discard: form.discard,
        }),
      }, PocketConsoleCard))

      // Load, then watch. The first report says whether this bundle reached the
      // page at all, which separates a mirror that is not landing from client
      // code the browser never ran.
      report('loaded')
      ctx.effect(() => {
        console.info('pocket-console: desktop mirror watching the conversation')
        report('watching')
        const stopMirror = startMirror()
        const stopPanel = watchPanel()
        return () => { stopMirror(); stopPanel() }
      }, 'pocket-console: desktop mirror')
    }

    module.exports = { apply, inject: ['slots', 'settingsScope'] }
    return module.exports
  },
})
