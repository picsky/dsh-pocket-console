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
 *   node scripts/probe-card-limits.mjs                # prints the plan, sends nothing
 *   node scripts/probe-card-limits.mjs --send         # sends every card, about 0.6 s apart
 *   node scripts/probe-card-limits.mjs --send --only P5
 *
 * It reads the app credentials and the bound recipient out of the local DSH credential store, the
 * same two things the plugin uses. It prints **lengths only**, never a secret, an `open_id` or a
 * `message_id`. The table probes touch nothing the plugin owns: no `element_id`, no interactive
 * element, no notice, and a fresh `uuid` per card. P5 is the exception and says so — it *is* a card
 * with controls, rendered by the plugin's own renderer, sent to the reader on purpose.
 *
 * Expected verdicts, as measured:
 *
 *   P0  one element, 4 tables      accepted
 *   P1  two elements, 3 + 2 = 5    accepted   <- five is still inside the ceiling
 *   P2  two elements, 3 + 3 = 6    refused    <- so the ceiling counts the whole card
 *   P3  one element, 5 tables      accepted   <- so "four per component" is not what is enforced
 *   P4  body 3 + fold 3 = 6        refused    <- so the fold shares the same ceiling
 *   P5  a real result card         accepted   <- the card the renderer actually builds ([#107])
 *
 * P5 is a different kind of probe: instead of a card written here, it is the **result card this
 * channel renders** — answer box, next-task box and all — because a documented field is not an
 * accepted one. It is also the only probe worth looking at: the two input boxes should arrive as
 * three-line boxes that say "最多 1000 字" in them.
 *
 * `--only P5` sends just that one, so re-running a probe does not put five cards on the phone again.
 *
 * @module dsh-pocket-console/scripts/probe-card-limits
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as Lark from '@larksuiteoapi/node-sdk'
import { renderCard } from '../providers/feishu.js'
import { messagesFor } from '../messages.js'

const send = process.argv.includes('--send')
/** One probe to run, when only one is wanted. */
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined

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

/**
 * The card this channel renders for a finished turn, asked about as a probe.
 *
 * Built by the renderer rather than written out here, because the question P5 asks is about the
 * document the plugin actually sends: both input boxes carry `input_type`, `rows` and `max_length`, and
 * a hand-written card that the platform accepts is no evidence at all about that one. It is also the
 * only probe a person needs to look at rather than read about — the boxes should arrive three lines
 * tall with the limit written in them.
 * @returns the card document.
 */
const resultCard = () => renderCard({
  title: '探针 P5 · 真实结果卡',
  tone: 'info',
  body: ['**探针**：下面两个输入框应当是**三行**高，并且框里写着「最多 1000 字」。不接受就不用管它。'],
  buttons: [],
  forms: [
    { payload: { rid: 'probe' }, fieldId: 'value', submitLabel: '发给 agent' },
    {
      payload: { rid: 'probe' },
      fieldId: 'next',
      submitLabel: '开始新任务',
      placeholder: messagesFor('zh').workPlaceholder,
    },
  ],
}, () => messagesFor('zh'))

/**
 * What one probe card carries, counted rather than described.
 *
 * The plan is printed before anything is sent, so it is the last chance to notice that a probe is
 * about to ask the wrong question — a card whose tables are not there, or whose input boxes are
 * single-line after all, would answer a question nobody asked and read as a platform verdict. Counts
 * only: no card text, no ids.
 * @param payload - the card document about to be sent.
 * @returns one line naming its elements, its tables and what its input boxes declare.
 */
const describeCard = (payload) => {
  const elements = payload.body.elements
  const textsOf = (list) => list.filter(element => typeof element.content === 'string').map(element => element.content)
  const folded = elements
    .filter(element => element.tag === 'collapsible_panel')
    .flatMap(panel => textsOf(panel.elements))
  const boxes = elements
    .filter(element => element.tag === 'form')
    .flatMap(form => form.elements)
    .filter(element => element.tag === 'input')
  // One separator row per Markdown table, which is what the platform counts.
  const tables = (textsOf(elements).concat(folded).join('\n').match(/^\| -/gm) ?? []).length
  return `元素 ${elements.length} · 表 ${tables}`
    + (boxes.length === 0
      ? ''
      : ` · 输入框 ${boxes.length}（${boxes.map(box => `${box.input_type}/${box.rows} 行/max_length=${box.max_length}`).join('、')}）`)
}

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
  ['P5', '真实结果卡（两个多行输入框，看是否被接受、是否显示成 3 行）', resultCard()],
]

/** The probes this run sends: one when `--only` names it, all of them otherwise. */
const selected = only === undefined ? probes : probes.filter(([id]) => id === only)

if (selected.length === 0) {
  console.error(`没有这个探针：${only}（有 ${probes.map(([id]) => id).join(' / ')}）`)
  process.exit(2)
}

if (!send) {
  console.log('计划（没有发送任何东西；加 --send 才真的发）：')
  for (const [id, what, payload] of selected) {
    console.log(`  ${id}  ${what}`)
    console.log(`        ${describeCard(payload)}`)
  }
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

for (const [id, what, payload] of selected) {
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
