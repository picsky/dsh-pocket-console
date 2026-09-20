import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const appId = process.env.FEISHU_APP_ID, appSecret = process.env.FEISHU_APP_SECRET
const mid = readFileSync('freeze-probe-id.txt', 'utf8').trim()
const token = (await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }) })).json()).tenant_access_token
const Hj = { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }
let n = 0
for (let i = 0; i < 60; i++) {
  n++
  const card = { schema: '2.0', config: { update_multi: true },
    header: { template: 'red', title: { tag: 'plain_text', content: `若你点了按钮，序号应停住 · 当前 #${n}` } },
    body: { elements: [{ tag: 'markdown', content: `**编辑序号：#${n}**\n\n时间 ${new Date().toISOString().slice(11, 19)}\n\n如果你点了按钮、而这个数字还在变 → 卡片被交互后仍可编辑。\n如果它停住了 → 卡片被交互即冻结。` }] } }
  const r = await (await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${mid}`, {
    method: 'PATCH', headers: Hj, body: JSON.stringify({ content: JSON.stringify(card) }) })).json()
  console.log(`${new Date().toISOString().slice(11,19)}  edit #${n}  ${r.code === 0 ? 'OK' : `FAIL(${r.code}) ${String(r.msg).slice(0,110)}`}`)
  if (r.code !== 0) { console.log('>>> 编辑被拒 = 卡片已冻结'); break }
  await sleep(4000)
}
console.log('观察结束（共', n, '次）')
