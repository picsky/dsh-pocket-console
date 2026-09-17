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
    const { IconChevronDownOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Settings namespace; also the `settings.plugin.item` slot key. */
    const NS = 'pocket-console'

    /** Same-origin route prefix the host half registers. */
    const ROUTE = '/__pocket'

    /** Section fields this card edits, in render order. */
    const FIELDS = [
      { field: 'delaySeconds', kind: 'number' },
      { field: 'maxDetailChars', kind: 'number' },
      { field: 'titlePrefix', kind: 'text' },
      { field: 'resultNotify', kind: 'select', options: ['off', 'idle'] },
      { field: 'resultNotifyCooldownSeconds', kind: 'number' },
    ]

    const COPY = {
      zh: {
        title: '口袋控制台',
        description: '把工具审批与提问送到手机，桌面始终优先。',
        bound: '已绑定',
        unbound: '未绑定',
        awaiting: '等待扫码确认',
        starting: '正在创建应用…',
        failed: '绑定失败',
        unsupported: '当前通道不支持绑定',
        recipient: '接收人',
        pending: '待审批',
        pendingApproval: '工具审批',
        pendingQuestion: '提问',
        pendingDelivered: '已送达手机',
        pendingWaiting: '等待桌面',
        scan: '用飞书扫描下面的二维码完成绑定。链接 10 分钟内有效，仅可使用一次。',
        bind: '开始绑定',
        rebind: '重新绑定',
        unbind: '解除绑定',
        unbindConfirm: '解除后手机上不再收到审批，确定吗？',
        retry: '重试',
        open: '在手机上打开这个链接',
        copy: '复制链接',
        copied: '已复制',
        loading: '读取中…',
        delay: '桌面专享时间',
        delayHint: '桌面在这段时间内可以先答；超时后同一条请求才会发到手机。0 表示同时可答。',
        maxDetailChars: '详情截断长度',
        maxDetailCharsHint: '单条原因、问题细节或选项说明渲染到手机上的最大字符数。',
        titlePrefix: '标题前缀',
        titlePrefixHint: '手机消息标题的前缀，用来区分不同部署。',
        resultNotify: '结果通知',
        resultNotifyHint: '会话停下来后，把本轮结果发到手机，并附上一个可以直接回复的输入框。',
        resultNotifyOff: '关闭',
        resultNotifyIdle: '空闲时通知',
        resultNotifyCooldownSeconds: '通知冷却（秒）',
        resultNotifyCooldownSecondsHint: '同一个会话两次结果通知之间的最短间隔，避免连续短任务刷屏。',
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
        starting: 'Creating the app…',
        failed: 'Binding failed',
        unsupported: 'This channel does not support binding',
        recipient: 'Recipient',
        pending: 'Pending',
        pendingApproval: 'Tool approval',
        pendingQuestion: 'Question',
        pendingDelivered: 'sent to the phone',
        pendingWaiting: 'waiting on the desktop',
        scan: 'Scan this code with Feishu to finish binding. The link is valid for 10 minutes and can be used once.',
        bind: 'Start binding',
        rebind: 'Bind again',
        unbind: 'Unbind',
        unbindConfirm: 'Approvals will stop reaching your phone. Continue?',
        retry: 'Retry',
        open: 'Open this link on your phone',
        copy: 'Copy link',
        copied: 'Copied',
        loading: 'Loading…',
        delay: 'Desktop head start',
        delayHint: 'Seconds the desktop may answer before the same request is sent to the phone. 0 makes both answerable at once.',
        maxDetailChars: 'Detail limit',
        maxDetailCharsHint: 'Longest reason, question detail, or option description rendered on the phone.',
        titlePrefix: 'Title prefix',
        titlePrefixHint: 'Prefix on every phone message title, for telling deployments apart.',
        resultNotify: 'Result notices',
        resultNotifyHint: 'After a session stops, send the turn result to the phone with a box to reply in.',
        resultNotifyOff: 'Off',
        resultNotifyIdle: 'When idle',
        resultNotifyCooldownSeconds: 'Notice cooldown (s)',
        resultNotifyCooldownSecondsHint: 'Shortest gap between two result notices for one session, so short turns do not flood the channel.',
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
        flex: 'none', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform .16s',
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
          maxDetailChars: fieldState('maxDetailChars'),
          titlePrefix: fieldState('titlePrefix'),
          resultNotify: fieldState('resultNotify'),
          resultNotifyCooldownSeconds: fieldState('resultNotifyCooldownSeconds'),
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

      const refresh = useCallback(async (signal) => {
        try {
          const response = await fetch(`${ROUTE}/state`, { signal, headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`state request failed: ${response.status}`)
          setRuntime(await response.json())
          setFailure(null)
        } catch (error) {
          if (error?.name === 'AbortError') return
          setFailure(String(error?.message ?? error))
        }
      }, [])

      useEffect(() => {
        const controller = new AbortController()
        void refresh(controller.signal)
        // Binding completes out of band, so the card polls while it is mounted.
        const timer = setInterval(() => { void refresh(controller.signal) }, 3000)
        return () => {
          controller.abort()
          clearInterval(timer)
        }
      }, [refresh])

      // A deployment that never composed the Host half shows no trace of the card.
      if (!shell.available) return null

      /** Run one binding operation, then adopt the enrollment it reports. */
      const run = async (path) => {
        setBusy(true)
        try {
          const response = await fetch(`${ROUTE}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
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
      const status = copy[enrollment.state] ?? copy.unbound

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
                copy[option === 'off' ? 'resultNotifyOff' : 'resultNotifyIdle'])))
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
              h('span', null, status)),
            enrollment.state === 'bound' && enrollment.recipient !== null && enrollment.recipient !== undefined
              ? h('div', { key: 'recipient', style: S.row },
                  h('span', { style: S.rowLabel }, copy.recipient), h('code', null, enrollment.recipient))
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
            failure !== null ? h('div', { key: 'failure', style: S.error }, failure) : null,
            h('div', { key: 'binding-actions', style: S.actions },
              enrollment.state === 'bound'
                ? button(copy.rebind, () => { void run('/bind') }, { disabled: busy })
                : button(enrollment.state === 'failed' ? copy.retry : copy.bind, () => { void run('/bind') }, { disabled: busy, primary: true }),
              enrollment.state === 'bound'
                ? button(copy.unbind, () => {
                    if (window.confirm(copy.unbindConfirm)) void run('/unbind')
                  }, { disabled: busy })
                : null),
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
          h(IconChevronDownOutline14, { style: S.chevron(open) })),

        open ? h('div', { style: S.body },
          !shell.writable ? h('p', { style: S.notice, role: 'status' }, copy.readOnly) : null,

          h('div', { style: S.section }, runtimeRows),

          field(FIELDS[0], copy.delay, copy.delayHint),
          field(FIELDS[1], copy.maxDetailChars, copy.maxDetailCharsHint),
          field(FIELDS[2], copy.titlePrefix, copy.titlePrefixHint),
          field(FIELDS[3], copy.resultNotify, copy.resultNotifyHint),
          field(FIELDS[4], copy.resultNotifyCooldownSeconds, copy.resultNotifyCooldownSecondsHint),

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
            ...(reason === undefined ? {} : { reason }),
            ...(syncId === undefined ? {} : { syncId }),
          }),
        }).catch(() => {})
      }

      /**
       * Poll the Host for a phone answer and mirror it. Renders nothing: it
       * exists so this page's composer stays in step with a decision taken
       * somewhere else.
       * @param props - the slot's session identity and the mirror verb.
       * @returns null.
       */
      function DesktopMirror(props) {
        const sessionId = props.sessionId
        React.useEffect(() => {
          // One line per mount and one per decision, so a page that is not
          // mirroring says which of the two it is doing.
          console.info(`pocket-console: desktop mirror watching session ${String(sessionId)}`)
          report('mounted')
          let stopped = false
          let applied = null
          let reported = null
          const poll = async () => {
            try {
              const sync = await readSync()
              if (stopped || sync === null || sync.id === applied) return
              const reason = props.applySync(sync)
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
          return () => { stopped = true; clearInterval(timer) }
        }, [sessionId])
        return null
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

      // The mirror mounts wherever the conversation shows a session, including
      // while its composer waits. Both outlets belong to the same conversation,
      // so each instance retries and whichever reaches the composer applies it.
      for (const slot of ['conversation.input.dock', 'conversation.input.overlay']) {
        ctx.slots.inject(slot, () => ctx.slots.register({
          name: slot,
          inject: (sessionId) => ({ sessionId, applySync }),
        }, DesktopMirror))
      }
    }

    module.exports = { apply, inject: ['slots', 'settingsScope'] }
    return module.exports
  },
})
