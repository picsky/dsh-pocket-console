/**
 * The card copy, in the deployment's language.
 *
 * Every string a person reads on the phone comes from here, so a deployment can
 * serve English cards without a code change, and so the copy has one home instead
 * of being spelled out at each call site. The core owns the request views and the
 * notices; a channel owns its own chrome and reads these for the parts it renders
 * itself, such as form placeholders.
 *
 * Functions carry the parts that vary (a tool name, a count, a clip mark), which
 * keeps formatting next to the language that formats it.
 *
 * @module pocket-console/messages
 */

/** Chinese copy: the default, and the language this plugin's docs are written beside. */
const zh = {
  /** Appended by `clip` when a long reason or detail was cut. */
  truncated: '…（内容过长已截断）',
  toolLabel: tool => `**工具**：\`${tool}\``,
  callIdLabel: id => `**调用 ID**：\`${id}\``,
  reasonLabel: reason => `**原因**：${reason}`,
  approvalLive: '桌面与手机同时可答，先到者生效。批准仅对本次调用生效。',
  approvalUpgraded: seconds => `桌面 ${seconds} 秒内未应答，已升级到手机。批准仅对本次调用生效。`,
  approvalTitle: '工具审批',
  questionTitle: '提问',
  questionOf: (position, total) => `提问 · 第 ${position}/${total} 题`,
  allowOnce: '批准一次',
  reject: '拒绝',
  progress: (answered, total) => `**进度**：已答 ${answered}/${total}`,
  optionsLegend: '**选项**',
  /** Joins several selected labels in a recorded answer. */
  selectionSeparator: '、',
  /** Separates recorded answers in the settlement headline. */
  answerSeparator: '；',
  submitAnswer: '提交本题',
  submitOther: '提交其他回答',
  allowedOnce: '已批准（仅本次）',
  rejected: '已拒绝',
  cancelled: '该请求已取消',
  answeredAtDesk: '已在桌面端处理',
  recorded: (answered, total) => `已记录 ${answered}/${total} 题`,
  answered: summary => `已回答：${summary}`,
  answersSubmitted: '已提交全部回答',
  requestGone: '该请求已处理或已过期',
  /** Titles a card that is rewritten because the request it asked about is gone. */
  requestGoneTitle: '请求已结束',
  actionUnknown: '无法识别该操作',
  /** Returned by the channel when a card action names no live request. */
  requestExpired: '该请求已失效',
  notRecipient: '只有绑定的接收人可以操作',
  platformUnreachable: '无法连接飞书开放平台（网络或代理不通）',
  unreachableWith: reason => `无法确认这组凭据：平台没有给出明确答复（可能是网络或代理不通）——${reason}`,
  wrongAppId: 'App ID 不存在，请确认它与开发者后台里显示的一致',
  wrongAppSecret: 'App Secret 不正确，请在开发者后台的「凭证与基础信息」里重新复制',
  credentialRejected: '飞书拒绝了这组凭据',
  connectionFailed: reason => `长连接建立失败：${reason}`,
  answerPlaceholder: '输入回答',
  notePlaceholder: '补充说明（可选）',
  appDescription: '把 DeepSeek Harness 的工具审批与提问送到飞书',
  resultTitle: '结果',
  replyHint: '**回复这条消息**即可把下一步交给这个会话。',
  sendToAgent: '发送给 agent',
  superseded: '**这条结果已被新的结果取代**，请用最新那条回复。',
  readerSpoke: '**该结果已有新消息**，这条通知不再接受回复。',
  noticeGone: '该结果已过期',
  emptyInstruction: '指令为空，未发送',
  noAgent: '会话已不在运行，指令未发送',
  sent: '已发送给 agent',
  received: '**已收到指令**，已排入该会话。',

  /**
   * Deployment log lines, in the deployment's language.
   *
   * The log is read by whoever is diagnosing *this* deployment, so it follows the
   * same `locale` the cards do rather than being split across two languages — a
   * reader who set `zh` should not have to read half the story in English. Lines
   * about the plugin's own internals (`index.js`) stay English: they describe the
   * harness's behaviour, not the deployment's.
   */
  logMessageRewriteFailed: '卡片改写失败',
  logDeliveryFailed: '消息投递失败',
  logCardTooLarge: '卡片被判定为超出体积上限，按一半长度重投一次。',
  logMirror: (status, reason) => `桌面镜像：${status}${reason === undefined ? '' : `（${reason}）`}`,
  logNotRecipient: '忽略非接收人的卡片操作。',
  logRecipientKept: '该部署已绑定接收人；忽略其他账号的私聊（改绑请在设置卡片里操作）。',
  logRecipientBound: openId => `绑定接收人：${openId}`,
  logTransportCloseFailed: '飞书长连接关闭失败',
  logPublishFailed: '飞书绑定状态发布失败',
  logOpenLink: (seconds) => `请在手机上打开以下链接完成飞书绑定（${seconds} 秒内有效，仅可使用一次）：`,
  logNoCredentials: '未找到飞书凭据，开始一键创建应用；请用飞书扫描或打开下面的链接。',
  logBindStatus: status => `绑定状态：${status}`,
  logAppCreated: appId => `飞书应用已创建：${appId}`,
  logReady: '飞书长连接已就绪。',
  logDisconnected: '飞书长连接断开，正在重连。',
  logReconnected: '飞书长连接已恢复。',
  logConnectionFailed: '飞书长连接失败；审批将只保留在桌面',
  logCredentialsRejected: detail => `飞书凭据未通过校验：${detail}`,
  logConnecting: '飞书长连接正在建立；就绪后开始接收审批。',
  logResumeFailed: '飞书通道恢复失败；审批将只保留在桌面',
  logPersistFailed: '应用凭据未能保存；本次连接仍使用填写的值',
  logAdopting: '已收到应用凭据，正在校验并连接飞书。',
  logEnrollmentFailed: '飞书绑定失败；审批将只保留在桌面',
  logNoticeFailed: '结果通知失败',
  logNoticeCooling: '结果未通知：同一会话仍在冷却期内。',
  logNoticeNoAgent: '结果未通知：该会话没有活跃 agent（本版本不恢复已回收的会话）。',
  logNoticeTooLarge: '通知被判定为超出体积上限，按一半长度重投一次。',
  logNoticeSent: '结果已发送到手机。',
  logNoticeSendFailed: '结果发送失败',
  logNoticeCardFailed: '结果卡片改写失败',
  logNoticeRetired: headline => `结果通知失效：${headline}`,
  logNoticeStoreUnavailable: '结果通知的持久存储不可用，重启后这些通知将不再有效。',
  logNoticeStoreAbsent: '本部署未装配持久存储服务，结果通知不会跨重启保留。',
  logNoticeStoreReady: '结果通知的持久存储已就绪。',
  logNoticeStoreWriteFailed: '结果通知的持久记录读写失败',
  logNoticeStoreReadFailed: '读取会话日志以核对结果通知失败',
  logNoticeRestoreFailed: '恢复上次运行的结果通知失败',
  logNoticeRestored: count => `已恢复 ${count} 条上次运行的结果通知，仍可回复。`,
  logInstructionQueued: '已把手机上的指令排入会话。',
  logInstructionFailed: '指令注入失败',
}

/** English copy. Same keys, and the same functions for the varying parts. */
const en = {
  truncated: '… (truncated)',
  toolLabel: tool => `**Tool**: \`${tool}\``,
  callIdLabel: id => `**Call id**: \`${id}\``,
  reasonLabel: reason => `**Reason**: ${reason}`,
  approvalLive: 'The desktop and the phone are both live; whichever answers first wins. Approval applies to this call only.',
  approvalUpgraded: seconds => `The desktop did not answer within ${seconds} seconds, so this went to the phone. Approval applies to this call only.`,
  approvalTitle: 'Tool approval',
  questionTitle: 'Question',
  questionOf: (position, total) => `Question ${position} of ${total}`,
  allowOnce: 'Allow once',
  reject: 'Reject',
  progress: (answered, total) => `**Progress**: ${answered}/${total} answered`,
  optionsLegend: '**Options**',
  selectionSeparator: ', ',
  answerSeparator: '; ',
  submitAnswer: 'Submit this answer',
  submitOther: 'Submit another answer',
  allowedOnce: 'Allowed once',
  rejected: 'Rejected',
  cancelled: 'This request was cancelled',
  answeredAtDesk: 'Answered at the desktop',
  recorded: (answered, total) => `Recorded ${answered}/${total}`,
  answered: summary => `Answered: ${summary}`,
  answersSubmitted: 'Every answer submitted',
  requestGone: 'That request was already handled or has expired',
  /** Titles a card that is rewritten because the request it asked about is gone. */
  requestGoneTitle: 'Request ended',
  actionUnknown: 'That action could not be recognized',
  requestExpired: 'That request has expired',
  notRecipient: 'Only the bound recipient can act on this card',
  platformUnreachable: 'The Feishu open platform could not be reached (network or proxy)',
  unreachableWith: reason => `Could not verify these credentials: the platform gave no clear answer (network or proxy?) — ${reason}`,
  wrongAppId: 'That App ID does not exist — check it against the developer console',
  wrongAppSecret: 'That App Secret is not correct — copy it again from Credentials & Basic Info',
  credentialRejected: 'Feishu rejected these credentials',
  connectionFailed: reason => `Could not establish the long connection: ${reason}`,
  answerPlaceholder: 'Type your answer',
  notePlaceholder: 'Extra note (optional)',
  appDescription: 'DeepSeek Harness tool approvals and questions, delivered to Feishu',
  resultTitle: 'Result',
  replyHint: '**Reply to this message** to hand the next step to this session.',
  sendToAgent: 'Send to the agent',
  superseded: '**A newer result replaced this one** — reply to that message instead.',
  readerSpoke: '**This session has a newer message**, so this notice no longer accepts a reply.',
  noticeGone: 'That result has expired',
  emptyInstruction: 'The instruction was empty, so nothing was sent',
  noAgent: 'That session is no longer running, so nothing was sent',
  sent: 'Sent to the agent',
  received: '**Instruction received** and queued for that session.',

  /** Deployment log lines. See the Chinese dictionary for why these are localized. */
  logMessageRewriteFailed: 'message rewrite failed',
  logDeliveryFailed: 'message delivery failed',
  logCardTooLarge: 'card read as over the size limit; retrying once at half the text.',
  logMirror: (status, reason) => `desktop mirror: ${status}${reason === undefined ? '' : ` (${reason})`}`,
  logNotRecipient: 'ignored a card action from someone other than the recipient.',
  logRecipientKept: 'this deployment already has a recipient; ignored a direct message from another account (change it from the Settings card).',
  logRecipientBound: openId => `bound recipient: ${openId}`,
  logTransportCloseFailed: 'closing the Feishu long connection failed',
  logPublishFailed: 'publishing the Feishu binding state failed',
  logOpenLink: seconds => `Open this link on your phone to finish binding Feishu (valid ${seconds} seconds, single use):`,
  logNoCredentials: 'no Feishu credentials found; starting the one-click app creation — scan or open the link below.',
  logBindStatus: status => `binding status: ${status}`,
  logAppCreated: appId => `Feishu app created: ${appId}`,
  logReady: 'the Feishu long connection is ready.',
  logDisconnected: 'the Feishu long connection dropped; reconnecting.',
  logReconnected: 'the Feishu long connection is back.',
  logConnectionFailed: 'the Feishu long connection failed; approvals will stay on the desktop',
  logCredentialsRejected: detail => `Feishu rejected these credentials: ${detail}`,
  logConnecting: 'opening the Feishu long connection; approvals start arriving once it is ready.',
  logResumeFailed: 'restoring the Feishu channel failed; approvals will stay on the desktop',
  logPersistFailed: 'the app credentials could not be saved; this connection still uses what was entered',
  logAdopting: 'app credentials received; checking them and connecting to Feishu.',
  logEnrollmentFailed: 'binding Feishu failed; approvals will stay on the desktop',
  logNoticeFailed: 'sending the result notice failed',
  logNoticeCooling: 'no notice: this session is still inside its cooldown.',
  logNoticeNoAgent: 'no notice: this session has no live agent (this version does not revive a reclaimed session).',
  logNoticeTooLarge: 'the notice read as over the size limit; retrying once at half the text.',
  logNoticeSent: 'the result was sent to the phone.',
  logNoticeSendFailed: 'sending the result failed',
  logNoticeCardFailed: 'rewriting the result card failed',
  logNoticeRetired: headline => `result notice retired: ${headline}`,
  logNoticeStoreUnavailable: 'durable storage for result notices is unavailable; after a restart these notices will no longer be valid.',
  logNoticeStoreAbsent: 'this deployment composes no durable storage service, so result notices are not kept across a restart.',
  logNoticeStoreReady: 'durable storage for result notices is ready.',
  logNoticeStoreWriteFailed: 'reading or writing a notice record failed',
  logNoticeStoreReadFailed: 'reading the session log to check a result notice failed',
  logNoticeRestoreFailed: 'restoring the result notices from the last run failed',
  logNoticeRestored: count => `restored ${count} result notice(s) from the last run; they still take a reply.`,
  logInstructionQueued: 'the instruction from the phone was queued for the session.',
  logInstructionFailed: 'injecting the instruction failed',
}

/** The languages a deployment can choose between. */
export const LOCALES = ['zh', 'en']

/**
 * The copy for one language.
 * @param locale - a configured locale; anything unknown reads as Chinese.
 * @returns that language's dictionary.
 */
export function messagesFor(locale) {
  return locale === 'en' ? en : zh
}
