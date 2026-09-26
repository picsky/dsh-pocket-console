/**
 * Measure the platform's real ceiling on tables in one card.
 *
 * This exists because the official documentation and the service disagree. The docs say a
 * rich-text (Markdown) component holds at most **four** tables; measured on 2026-09-26 against
 * this deployment's own tenant, a single element carrying **five** tables was accepted, while a
 * card carrying **six** tables across two elements was refused with
 * `230099 / ErrCode: 11310 / ErrMsg: card table number over limit`. What the platform enforces is
 * therefore a **card-wide count of five**, not a per-component count — and the fold shares it.
 * See `internal/feishu-limits.md`.
 *
 * The probe is deliberately **not** part of `npm test`: it sends real cards to a real phone. Run it
 * by hand against a bound deployment on this machine:
 *
 *   node scripts/probe-card-limits.mjs            # prints the plan, sends nothing
 *   node scripts/probe-card-limits.mjs --send     # sends the five cards, about 3 s apart
 *
 * It reads the app credentials and the bound recipient out of the local DSH credential store, the
 * same two things the plugin uses. It prints **lengths only**, never a secret, an `open_id` or a
 * `message_id`. It touches nothing the plugin owns: no `element_id`, no interactive element, no
 * notice, and a fresh `uuid` per card.
 *
 * Expected verdicts, as measured:
 *
 *   P0  one element, 4 tables      accepted
 *   P1  two elements, 3 + 2 = 5    accepted   <- five is still inside the ceiling
 *   P2  two elements, 3 + 3 = 6    refused    <- so the ceiling counts the whole card
 *   P3  one element, 5 tables      accepted   <- so "four per component" is not what is enforced
 *   P4  body 3 + fold 3 = 6        refused    <- so the fold shares the same ceiling
 *
 * @module dsh-pocket-console/scripts/probe-card-limits
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as Lark from '@larksuiteoapi/node-sdk'

const send = process.argv.includes('--send')

/** One Markdown table worth `n`, small enough that no size budget is in play. */
const table = (n) => `表 ${n}\n\n| 列 A | 列 B |\n| --- | --- |\n| a | ${n} |\n| b | ${n} |\n`

/** `count` tables in one string: this is what "one element holds N tables" means. */
const many = (count, from = 1) => Array.from({ length: count }, (_, i) => table(from + i)).join('\n')

/**
 * One probe card, JSON 2.0, no interactive element.
 * @param options - the title, the line under it, and how many tables go in the body and the fold.
 * @returns the card document.
 */
const card = ({ title, note, body = [], fold = [] }) => ({
  schema: '2.0',
  config: { update_multi: true },
  header: { template: 'blue', title: { tag: 'plain_text', content: title } },
  body: {
    elements: [
      { tag: 'markdown', content: `**限制探针** — ${note}` },
      ...body.map((content) => ({ tag: 'markdown', content })),
      ...(fold.length === 0 ? [] : [{
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'markdown', content: '**折叠里的表**' } },
        elements: fold.map((content) => ({ tag: 'markdown', content })),
      }]),
    ],
  },
})

const probes = [
  ['P0', '单元素 4 表（文档写的单组件上限）',
    card({ title: '探针 P0 · 1 个元素 4 张表', note: '预期通过', body: [many(4)] })],
  ['P1', '正文 3 表 + 2 表 = 5（探卡级上限是否恰为 5）',
    card({ title: '探针 P1 · 3+2=5 张表', note: '若卡级额度是 5，这张应当通过', body: [many(3), many(2, 4)] })],
  ['P2', '正文 3 表 + 3 表 = 6（探 Markdown 表是否共用卡级额度）',
    card({ title: '探针 P2 · 3+3=6 张表', note: '六张都在正文，每个元素都不超 4', body: [many(3), many(3, 4)] })],
  ['P3', '单元素 5 表（探单组件上限是否恰为 4）',
    card({ title: '探针 P3 · 1 个元素 5 张表', note: '若被拒，说明单组件上限是 4', body: [many(5)] })],
  ['P4', '正文 3 表 + 折叠 3 表（探折叠是否共用额度）',
    card({ title: '探针 P4 · 正文 3 + 折叠 3', note: '若被拒，说明折叠里的表也计入', body: [many(3)], fold: [many(3, 4)] })],
]

if (!send) {
  console.log('计划（没有发送任何东西；加 --send 才真的发）：')
  for (const [id, what] of probes) console.log(`  ${id}  ${what}`)
  process.exit(0)
}

const home = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const creds = readFileSync(join(home, '.credentials.yaml'), 'utf8')
const scalar = (key) => creds.match(new RegExp('^\\s*' + key + ':\\s*(\\S+)\\s*$', 'm'))?.[1]
const appId = scalar('DSH_FEISHU_APP_ID')
const appSecret = scalar('DSH_FEISHU_APP_SECRET')
const recipient = creds.split(/^ {2}pocket-console\/recipient:\s*$/m)[1] ?? ''
const receiveId = recipient.match(/^\s+id:\s*(\S+)\s*$/m)?.[1]

if (appId === undefined || appSecret === undefined || receiveId === undefined) {
  console.error('没有拿到应用凭据或已绑定的接收人：先让插件在这台机器上完成绑定。')
  console.error({ appId: appId !== undefined, appSecret: appSecret !== undefined, recipient: receiveId !== undefined })
  process.exit(2)
}
// Lengths only. The values never reach stdout, a log, or a commit.
console.log(`appId=<${appId.length} 字符> appSecret=<${appSecret.length} 字符> 接收人=<${receiveId.length} 字符>`)

const client = new Lark.Client({ appId, appSecret, domain: Lark.Domain.Feishu })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []

for (const [id, what, payload] of probes) {
  let line
  try {
    const response = await client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(payload),
        uuid: randomUUID(),
      },
    })
    const code = response?.code ?? 0
    // The message id is deliberately not printed: it is tenant-scoped, and the verdict is the point.
    line = code === 0
      ? 'ACCEPTED'
      : `REFUSED   code=${code} msg=${String(response?.msg ?? '').slice(0, 300)}`
  } catch (error) {
    const data = error?.response?.data
    line = `REFUSED   code=${data?.code ?? '?'} msg=${String(data?.msg ?? error?.message ?? '').slice(0, 300)}`
  }
  console.log(`${id}  ${what}\n    -> ${line}`)
  results.push(`${id}  ${line}`)
  await sleep(600)
}

console.log('\n=== summary ===')
for (const row of results) console.log(row)
