/**
 * Browser half of dsh-pocket-console.
 *
 * Registers one card under `settings.plugin.item` keyed by this plugin's
 * settings namespace, which is the documented way a plugin distributed outside
 * the DSH repository contributes a Settings → Plugins card.
 *
 * The Host half serves `/__pocket/*` on the same webserver that serves this
 * page, so the card talks to its own host half over same-origin `fetch` — the
 * browser's existing session already applies and no Remote method is needed.
 *
 * Hand-written in the client module system's factory format, so the package
 * ships and installs with no build step. `require` is the shell's module table;
 * only its platform modules may be requested.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pocket-console',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports

    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    /** Settings namespace; also the `settings.plugin.item` slot key. */
    const NS = 'pocket-console'

    /** Same-origin route prefix the host half registers. */
    const ROUTE = '/__pocket'

    const COPY = {
      zh: {
        title: '口袋审批',
        bound: '已绑定',
        unbound: '未绑定',
        awaiting: '等待扫码确认',
        starting: '正在创建应用…',
        failed: '绑定失败',
        recipient: '接收人',
        pending: '待审批',
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
        delay: '桌面专享时间（秒）',
        prefix: '标题前缀',
      },
      en: {
        title: 'Pocket approval',
        bound: 'Bound',
        unbound: 'Not bound',
        awaiting: 'Waiting for confirmation',
        starting: 'Creating the app…',
        failed: 'Binding failed',
        recipient: 'Recipient',
        pending: 'Pending',
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
        delay: 'Desktop head start (seconds)',
        prefix: 'Title prefix',
      },
    }

    /** Read the host half's current snapshot. */
    async function readState(signal) {
      const response = await fetch(`${ROUTE}/state`, { signal, headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`state request failed: ${response.status}`)
      return await response.json()
    }

    /** Ask the host half to perform one mutating operation. */
    async function post(path) {
      const response = await fetch(`${ROUTE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
      return await response.json()
    }

    const row = (label, value) => h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
      h('span', { style: { opacity: 0.6, minWidth: '8rem' } }, label),
      h('span', null, value))

    const button = (label, onClick, disabled) => h('button', {
      type: 'button',
      onClick,
      disabled,
      style: {
        padding: '4px 12px',
        border: '1px solid currentColor',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        font: 'inherit',
      },
    }, label)

    /**
     * One card: binding state, the scan code while awaiting, and the controls.
     * @param props - the inject face the registration supplies.
     */
    function PocketApprovalCard(props) {
      const copy = props.copy
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [copied, setCopied] = useState(false)

      const refresh = useCallback(async (signal) => {
        try {
          const next = await readState(signal)
          setState(next)
          setError(null)
        } catch (failure) {
          if (failure?.name === 'AbortError') return
          setError(String(failure?.message ?? failure))
        }
      }, [])

      useEffect(() => {
        const controller = new AbortController()
        void refresh(controller.signal)
        // Onboarding completes out of band, so the card polls while it waits.
        const timer = setInterval(() => { void refresh(controller.signal) }, 3000)
        return () => {
          controller.abort()
          clearInterval(timer)
        }
      }, [refresh])

      const run = useCallback(async (operation) => {
        setBusy(true)
        try {
          const next = await operation()
          if (next !== undefined) setState((previous) => ({ ...previous, enrollment: next }))
          setError(null)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }, [])

      const enrollment = state?.enrollment ?? { state: 'unbound' }
      const settings = state?.settings ?? {}
      const verifyUrl = enrollment.verifyUrl

      const status = (() => {
        switch (enrollment.state) {
          case 'bound': return copy.bound
          case 'awaiting': return copy.awaiting
          case 'starting': return copy.starting
          case 'failed': return copy.failed
          default: return copy.unbound
        }
      })()

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        row(copy.title, status),
        enrollment.state === 'bound' && enrollment.recipient !== null && enrollment.recipient !== undefined
          ? row(copy.recipient, h('code', null, enrollment.recipient))
          : null,
        row(copy.pending, String(state?.pending ?? 0)),
        row(copy.delay, String(settings.delaySeconds ?? '')),
        row(copy.prefix, String(settings.titlePrefix ?? '')),

        verifyUrl !== undefined && enrollment.state === 'awaiting'
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('div', { style: { opacity: 0.8 } }, copy.scan),
              h('img', {
                src: `${ROUTE}/qr.svg`,
                alt: copy.open,
                width: 240,
                height: 240,
                style: { background: '#fff', padding: '8px', borderRadius: '8px', alignSelf: 'flex-start' },
              }),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h('a', { href: verifyUrl, target: '_blank', rel: 'noreferrer' }, copy.open),
                button(copied ? copy.copied : copy.copy, () => {
                  void navigator.clipboard?.writeText(verifyUrl).then(() => {
                    setCopied(true)
                    setTimeout(() => { setCopied(false) }, 2000)
                  })
                }, false)))
          : null,

        enrollment.state === 'failed' && enrollment.message !== undefined
          ? h('div', { style: { color: 'var(--dsw-alias-text-danger, #d03050)' } }, enrollment.message)
          : null,

        error !== null ? h('div', { style: { color: 'var(--dsw-alias-text-danger, #d03050)' } }, error) : null,

        h('div', { style: { display: 'flex', gap: '8px' } },
          enrollment.state === 'bound'
            ? button(copy.rebind, () => { void run(() => post('/bind')) }, busy)
            : button(enrollment.state === 'failed' ? copy.retry : copy.bind,
                () => { void run(() => post('/bind')) }, busy),
          enrollment.state === 'bound'
            ? button(copy.unbind, () => {
                if (window.confirm(copy.unbindConfirm)) void run(() => post('/unbind'))
              }, busy)
            : null),
      )
    }

    /**
     * Register the card under this plugin's settings namespace.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        inject: () => ({ copy: COPY.zh }),
      }, PocketApprovalCard))
    }

    module.exports = { apply, inject: ['slots'] }
    return module.exports
  },
})
