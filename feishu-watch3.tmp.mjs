import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const appId = process.env.FEISHU_APP_ID, appSecret = process.env.FEISHU_APP_SECRET
const mid = readFileSync('freeze2-id.txt', 'utf8').trim()
const token = (await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }) })).json()).tenant_access_token
const Hj = { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }
let n = 0
for (let i = 0; i < 90; i++) {
  n++
  const card = { schema: '2.0', config: { update_multi: true },
    header: { template: 'red', title: { tag: 'plain_text', content: `若你提交了，这个数字应该停住 · 现在 #${n}` } },
    body: { elements: [{ tag: 'markdown', content: `**改写序号：#${n}**\n\n时间 ${new Date().toISOString().slice(11, 19)}\n\n提交后若它**继续变大** → 交互过的卡仍可改写。\n若它**停住** → 卡片被冻结（平台却返回成功，这才是最坏的一种）。` }] } }
  const r = await (await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${mid}`, {
    method: 'PATCH', headers: Hj, body: JSON.stringify({ content: JSON.stringify(card) }) })).json()
  console.log(`${new Date().toISOString().slice(11,19)}  改写 #${n}  ${r.code === 0 ? '被接受' : `被拒绝 code=${r.code} ${String(r.msg).slice(0,90)}`}`)
  if (r.code !== 0) { console.log('>>> 平台明确拒绝：交互后退回为不可编辑'); break }
  await sleep(5000)
}
console.log('观察结束（共', n, '次）')
