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
  /** Prepended when the *end* of a folded record was kept and its beginning dropped. */
  truncatedOlder: '（更早的内容已省略）…\n\n',
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
  /**
   * The small line under a card's title, naming the session it belongs to.
   *
   * The title says what the card is and which project it belongs to; two sessions in one project make
   * two identical titles, and this is the line that tells them apart. The label is spelled out
   * because the line sits under a title with no other context.
   */
  sessionLine: name => `会话：${name}`,
  logSessionNamed: (session, name) => `会话名：${session} → ${name}`,
  replyHint: '**回复这条消息**即可把下一步交给这个会话；也可以直接在聊天里**引用回复**它。引用后发 `/new <内容>` 开一段新的，发 `/help` 看全部用法。',
  /** Label over the folded record of what this run did, on the result card. */
  resultProcess: '思考过程',
  /** Placed between the two ends of a run whose middle did not fit, so a reader knows it is partial. */
  resultOmitted: bytes => `**……中间省略约 ${bytes} 字节……**`,
  /**
   * One tool call, named by its kind and never by its arguments.
   *
   * The phone question is how far along a run is, so a call is one line saying what sort of step it
   * was. A tool with no kind is not guessed at: a wrong kind is worse than an unspecific one.
   */
  toolKind: (kind, name) => ({
    read: '▸ 读取',
    search: '▸ 搜索',
    write: '▸ 写入文件',
    edit: '▸ 改动文件',
    command: '▸ 运行命令',
    code: '▸ 执行代码',
    other: `▸ 调用工具${name === undefined || name === '' ? '' : `：\`${name}\``}`,
  })[kind] ?? `▸ 调用工具${name === undefined || name === '' ? '' : `：\`${name}\``}`,
  /** The same line, once the run has collapsed repeated calls of one kind into it. */
  toolKindRepeated: (label, count) => `${label} ×${count}`,
  sendToAgent: '发送给 agent',
  superseded: '**这条结果已被新的结果取代**，请用最新那条回复。',
  readerSpoke: '**该结果已有新消息**，这条通知不再接受回复。',
  noticeGone: '该结果已过期',
  /** Card copy for a notice whose session was delegated to, so its result arrives elsewhere. */
  noticeDelegated: '这个会话是被委派的，结果由发起它的会话汇报',
  /** Card copy for a notice that is gone, which does not know or claim why. */
  noticeStale: '这条通知已不再有效',
  emptyInstruction: '指令为空，未发送',
  noAgent: '会话已不在运行，指令未发送',
  sent: '已发送给 agent',
  notSent: '**没能送出去**，这条指令没有进入会话。输入框还在，请再试一次。',
  received: '**已收到指令**，已排入该会话。',
  workIntro: '在一个**新会话**里开一轮，工作区沿用这个会话的。',
  workOfferHint: '---\n\n或者，在**新会话**里开下一段：',
  workPlaceholder: '新会话要做什么？',
  workStart: '开始新任务',
  workStarted: workspace => `**已开新会话**${workspace === undefined ? '' : ` · ${workspace}`}，本轮结束后会像往常一样通知你。`,
  workAlreadyStarted: '这张卡已经开过一次新会话了，不会再开第二次。',
  noSessionController: '这个部署没有会话控制器，开不了新会话。',
  logWorkStarted: (session, workspace) => `新会话已开始：${session}（工作区 ${workspace ?? '未知'}）。`,
  logWorkFailed: '开新会话失败',
  logWorkUnowned: cwd => `要继承的目录不属于任何工作区（${cwd}），新会话会落在网页端的「未分组」里。`,
  logWorkUngrouped: '新会话没能挂进工作区，已退回按目录创建；它会落在网页端的「未分组」里',

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
  logRewriteAttempts: attempts => `（已重试 ${attempts} 次）`,
  logDeliveryFailed: '消息投递失败',
  logCardTooLarge: '卡片被判定为超出体积上限，按一半长度重投一次。',
  logDeliveryRetrying: attempt => `消息投递第 ${attempt} 次尝试未成功，稍后重试。`,
  logDeliveryGivenUp: tries => `审批/提问卡连续 ${tries} 次发送失败，已放弃本次升级；这条请求回到桌面。`,
  logStalePress: '按了一张已失效的卡（进程重启，或请求已结束）；这张卡已改写为「已结束」。',
  logCardOverBodyBudget: (bytes, budget) => `要发出的卡片有 ${bytes} 字节，超过整卡预算 ${budget}：先丢掉折叠面板，仍超出则按比例缩短正文。`,
  logCardTablesFlattened: (tables, budget) => `卡片里的表格超过整卡预算 ${budget}（平台按整卡计，超过 5 张就整卡被拒）：这 ${tables} 张表已改写为文本，内容没有丢。`,
  logNoticeRefused: (kind, code, message) => `结果卡被平台拒绝（类型=${kind}，码=${code ?? '无'}）：${message === '' ? '没有给出原因' : message}`,
  logNoticeTablesFlattened: tables => `这张结果卡有 ${tables} 张表被改写成文本后重投。`,
  logNoticeFellBackToText: '结果卡的所有降级都没能通过，已改用纯文本消息把内容发出去（会没有回复框）。',
  logNoticeFallbackFailed: '连纯文本兜底也失败了，这一轮的内容没有送到手机上。',
  /** The headline on the plain-text message a result falls back to when no card can be delivered. */
  fallbackHeadline: '（这张结果卡没能发出去，先把内容发给你；没有回复框，要回它请到桌面。）',
  /** Typed messages: the help text, the hints, and the two ways an instruction can fail. */
  helpText: [
    '这个机器人怎么用：',
    '· **引用回复**一张卡（结果卡/执行中卡）= 把下一步交给那个会话；跑着的时候会插进当前那一轮。',
    '· 引用一张卡后发 **`/new <内容>`** = 在那个卡的工作区里开一个**新会话**（工作区沿用，不能自己选）。',
    '· 引用一张**提问卡**，直接把你想要的答案写在消息里 = 那就是这道题的答复（选项文字写对就是选它，写别的就是"其他"）。',
    '· 引用一张**审批卡**，回「**允许**」或「**拒绝**」= 和按按钮一样（只认这两个词）。',
    '· 审批和提问也可以**按卡片上的按钮**，或填卡片上的输入框。',
    '· **不引用任何卡**直接发的消息**不会被处理**——宁可不动，也不把指令投进错的会话。',
    '· `/help` = 这条说明。',
  ].join('\n'),
  hintUnquoted: '这条消息我没有处理：我看不出它属于哪个会话。要交给某个会话，请**引用回复**那张卡；要开新会话，引用后以 `/new ` 开头；发 `/help` 看全部用法。',
  hintEmpty: '这条引用里没有内容，我什么都没做。',
  hintOrphanNew: '`/new` 需要**引用一张卡**，我才能知道新会话该用哪个工作区。',
  hintEmptyNew: '`/new` 后面还要写上要做什么。',
  messageReplyFailed: reason => `这条指令没有送出去（${String(reason ?? '原因不明')}）。那张卡仍然可以回复，也可以在卡片输入框里再试一次。`,
  messageNewFailed: '新会话没能起来（原因在部署日志里）。请到桌面看一眼，或再试一次。',
  messageNotAnAnswer: kind => (kind === 'approval'
    ? '这张是**审批卡**：回「**允许**」或「**拒绝**」就行，别的词我不会替你决定。'
    : '这条答复我没能用上——那张卡现在问的可能是另一道题了，看一眼卡片再回一次。'),
  messageAnswerGone: '这张卡对应的请求现在已经不在了（可能在桌面答过、被取消，或者插件重启过）。我什么都没做。',
  logMessageAnswerFailed: '经聊天消息答复一张卡片失败。',
  logMessageFailed: '处理一条聊天消息时出错。',
  logMessageReplyFailed: '回一条聊天消息时出错。',
  logInstructionFailed: '经聊天消息下发的指令没有送到会话。',
  logMessageNewFailed: '经聊天消息开新会话失败。',
  logMessageRepeat: '同一条消息被平台重复推送，已丢弃。',
  logMirror: (status, reason) => `桌面镜像：${status}${reason === undefined ? '' : `（${reason}）`}`,
  logMirrorLapsed: '有一条手机决定，在任何一个浏览器前来取走它之前就过期了；那个等待中的窗口没有被关闭。',
  logPhonePriority: '已切换到手机优先：接下来的消息不再等待桌面专享时间。',
  logDeskPriority: '已回到桌面优先：消息重新按桌面专享时间等待。',
  logPriorityStoreFailed: '优先侧未能保存；本次运行仍然生效，但重启后会回到桌面优先。',
  logPriorityRestoreFailed: '读取已保存的优先侧失败；本次从桌面优先开始。',
  logPriorityListenerFailed: '优先侧变化时的处理失败',
  /** Activity card: the status line, then the labels the card uses. */
  activityRunning: '处理中',
  activityWaiting: '等待工具',
  activityStopped: '已停止',
  activityError: '出错',
  activityInterrupted: '已中断',
  activityStep: (turn, step) => `第 ${turn} 轮 · 第 ${step} 步`,
  activityTurn: turn => `第 ${turn} 轮`,
  activityElapsed: seconds => `已跑 ${seconds} 秒`,
  activityTool: name => `**工具**：\`${name}\``,
  activityFailed: reason => `**失败**：${reason}`,
  activityNothingYet: '（这一步还没有文本输出）',
  activityTruncated: '输出达到上限而中断，任务没有做完。',
  /** Label over the folded record of a finished run, on the frozen card. */
  activityProcess: '本次执行过程',
  activityFrozen: '已结束',
  /** One failed tool call, in the folded record of a finished run. */
  activityToolFailed: (name, reason) => `**工具失败**：\`${name}\`${reason === '' ? '' : ` — ${reason}`}`,
  /** A person's own words inside a folded record: the one entry the fold marks. */
  humanLine: text => `**你**：${text}`,
  activityTitle: '执行中',
  logActivitySent: '已为这次运行发出活动卡。',
  logActivitySendFailed: '活动卡发送失败',
  logActivityUpdateFailed: '活动卡刷新失败',
  logActivityGivenUp: (tries, session) => `活动卡连续 ${tries} 次写失败，已放弃维护它（会话 ${session}）。这张卡会停在最后一次成功的样子上。`,
  logDeskSignalSeen: (without) => `「人在桌面」的判据生效了：第一条带网关 request id 的人类消息已到达（此前有 ${without} 条不带）。`,
  logDeskSignalAbsentSoFar: '第一条人类消息没带 request id。这本身不说明判据坏了——从手机发来的消息也不带；但如果桌面发的消息也一直不带，就说明上游那个未声明的字段变了。',
  logSubscribedCallbacks: names => `为按钮订阅的回调事件名：${names}。`,
  logSubscribedEvents: names => `为私聊订阅的事件名：${names}。`,
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
  logProbeRejected: detail => `探活发现飞书不再认可这组应用凭据（${detail}），已关闭长连接；请检查应用或重新绑定。`,
  logProbeUnreachable: '探活未能联系上飞书（网络问题），暂不改变连接状态。',
  logNoticeFailed: '结果通知失败',
  logNoticeCooling: '结果未通知：同一会话仍在冷却期内。',
  logNoticeNoAgent: '结果未通知：该会话没有活跃 agent（本版本不恢复已回收的会话）。',
  logNoticeTooLarge: '通知被判定为超出体积上限，按一半长度重投一次。',
  logNoticeRetrying: attempt => `结果发送第 ${attempt} 次尝试未成功，稍后重试。`,
  logNoticeSent: '结果已发送到手机。',
  /** Whether the result card carried the run, since a missing fold and an unrecorded run look alike. */
  logRunFold: (session, entries, carried) => carried
    ? `结果卡带上了这一段过程（${entries} 条）。`
    : `这一段过程是空的（${entries} 条），结果卡上不会有折叠面板。`,
  /** The shape of the view the result card was built from, for a report that cannot be seen. */
  logResultView: shape => `结果卡视图：${shape}`,
  logNoticeSendFailed: '结果发送失败',
  logNoticeCardFailed: '结果卡片改写失败',
  logReplyCardRewritten: handle => `已把回复后的结果卡改写为「已收到指令」（消息 ${handle}）。`,
  logReplyCardAdopted: handle => `回复后的结果卡（消息 ${handle}）已交给执行中的卡：接下来这一段跑在同一张卡上，不再另发。`,
  logReplyCardNotRewritten: state => `回复已被接受，但结果卡没有改写：会话=${state.session ? '有' : '无'}、发出时的卡=${state.view ? '有' : '无'}、消息=${state.handle || '无'}。`,
  logNoticeRetired: headline => `结果通知失效：${headline}`,
  logNoticeStoreUnavailable: '结果通知的持久存储不可用，重启后这些通知将不再有效。',
  logNoticeStoreAbsent: '本部署未装配持久存储服务，结果通知不会跨重启保留。',
  logNoticeStoreReady: '结果通知的持久存储已就绪。',
  logNoticeStoreWriteFailed: '结果通知的持久记录读写失败',
  logNoticeStoreReadFailed: '读取会话日志以核对结果通知失败',
  logNoticeRestoreFailed: '恢复上次运行的结果通知失败',
  logNoticeRestored: count => `已恢复 ${count} 条上次运行的结果通知，仍可回复。`,
  logNoticeStored: rid => `结果通知已记入持久存储（${rid}）。`,
  logNoticeRestoreEmpty: '上次运行没有留下结果通知。',
  logNoticeRestoreRetired: (rid, reason) => `恢复通知 ${rid} 时作废：${reason}`,
  logInstructionQueued: '已把手机上的指令排入会话。',
  logInstructionSteered: '会话正在跑，已把手机上的指令作为 steer 送进当前这一轮。',
  /** The face of a result card for a turn that stopped before it finished. */
  noticeUnfinished: (kind, why) => {
    const headline = kind === 'max-tokens'
      ? '**输出达到上限而中断**，这一轮没有做完。'
      : '**这一轮出错了**，没有跑完。'
    return why === '' ? headline : `${headline}\n\n${why}`
  },
  logInstructionFailed: '指令注入失败',
}

/** English copy. Same keys, and the same functions for the varying parts. */
const en = {
  truncated: '… (truncated)',
  truncatedOlder: '(earlier content omitted)…\n\n',
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
  sessionLine: name => `Session: ${name}`,
  logSessionNamed: (session, name) => `session name: ${session} → ${name}`,
  replyHint: '**Reply to this message** to hand the next step to this session — or quote it in the chat. Quote it and start with `/new <what to do>` for a new one; send `/help` for the full list.',
  resultProcess: 'Thinking',
  resultOmitted: bytes => `**…… about ${bytes} bytes left out in the middle ……**`,
  /** One tool call, named by its kind and never by its arguments. See the Chinese copy for why. */
  toolKind: (kind, name) => {
    const labels = {
      read: '▸ read',
      search: '▸ search',
      write: '▸ write file',
      edit: '▸ edit file',
      command: '▸ run command',
      code: '▸ run code',
    }
    return labels[kind] ?? `▸ tool${name === undefined || name === '' ? '' : `: \`${name}\``}`
  },
  toolKindRepeated: (label, count) => `${label} ×${count}`,
  sendToAgent: 'Send to the agent',
  superseded: '**A newer result replaced this one** — reply to that message instead.',
  readerSpoke: '**This session has a newer message**, so this notice no longer accepts a reply.',
  noticeGone: 'That result has expired',
  noticeDelegated: 'This session was delegated to, so its result arrives with the session that asked for it',
  noticeStale: 'This notice is no longer live',
  emptyInstruction: 'The instruction was empty, so nothing was sent',
  noAgent: 'That session is no longer running, so nothing was sent',
  sent: 'Sent to the agent',
  notSent: '**It did not get through** — the instruction never reached the session. The box is still there, so please try again.',
  received: '**Instruction received** and queued for that session.',
  workIntro: 'Start a turn in a **new session**, using this one\'s workspace.',
  workOfferHint: '---\n\nOr start the next stretch in a **new session**:',
  workPlaceholder: 'What should the new session do?',
  workStart: 'Start a new task',
  workStarted: workspace => `**New session started**${workspace === undefined ? '' : ` · ${workspace}`}; you will hear about its result as usual.`,
  workAlreadyStarted: 'This card has already started one new session; it will not start a second.',
  noSessionController: 'this deployment has no session controller, so it cannot start a new session.',
  logWorkStarted: (session, workspace) => `started a new session: ${session} (workspace ${workspace ?? 'unknown'})`,
  logWorkFailed: 'starting a new session failed',
  logWorkUnowned: cwd => `the directory to inherit belongs to no workspace (${cwd}); the new session will sit under "ungrouped" in the Web interface.`,
  logWorkUngrouped: 'the new session could not be attached to a workspace and was created by directory instead; it will sit under "ungrouped" in the Web interface',

  /** Deployment log lines. See the Chinese dictionary for why these are localized. */
  logMessageRewriteFailed: 'message rewrite failed',
  logRewriteAttempts: attempts => ` (retried ${attempts} times)`,
  logDeliveryFailed: 'message delivery failed',
  logCardTooLarge: 'card read as over the size limit; retrying once at half the text.',
  logDeliveryRetrying: attempt => `message delivery attempt ${attempt} failed; retrying shortly.`,
  logDeliveryGivenUp: tries => `gave up escalating after ${tries} failed deliveries; this request goes back to the desk.`,
  logStalePress: 'a card with no live request was pressed (a restart, or a request that already settled); it was rewritten as finished.',
  logCardOverBodyBudget: (bytes, budget) => `the card about to go out weighs ${bytes} bytes, over the whole-card budget of ${budget}: the fold is dropped first, and the text is shortened proportionally if that is not enough.`,
  logCardTablesFlattened: (tables, budget) => `the card carries more tables than the whole-card budget of ${budget} (the platform counts them across the card and refuses it past five): ${tables} of them were written as text, and nothing was dropped.`,
  logNoticeRefused: (kind, code, message) => `the result card was refused by the platform (kind=${kind}, code=${code ?? 'none'}): ${message === '' ? 'no reason was given' : message}`,
  logNoticeTablesFlattened: tables => `${tables} tables on this result card were written as text and it was sent again.`,
  logNoticeFellBackToText: 'every degradation of the result card was refused; the answer went out as a plain-text message instead (no reply box).',
  logNoticeFallbackFailed: 'even the plain-text fallback failed: this turn\'s content did not reach the phone.',
  fallbackHeadline: '(this result card could not be delivered, so here is the content; there is no reply box — answer it from the desk.)',
  helpText: [
    'How this bot is used:',
    '· **Reply to a card** (a result card or the running card) = hand the next step to that session; if it is running, it is steered into the current turn.',
    '· Reply to a card and start with **`/new <what to do>`** = open a **new session** in that card\'s workspace (inherited, never chosen).',
    '· Quote a **question card** and write the answer as the message = that is the answer (an option\'s exact words select it; anything else is the typed answer).',
    '· Quote an **approval card** and reply **`allow`** or **`reject`** = the same as pressing the button (those two words only).',
    '· Approvals and questions can also be answered with the **buttons on the card**, or its input box.',
    '· A message that **quotes no card is not acted on** — doing nothing beats sending an instruction to the wrong session.',
    '· `/help` = this list.',
  ].join('\n'),
  hintUnquoted: 'I did not act on this message: I cannot tell which session it belongs to. To reach one, **reply to (quote) that card**; to open a new session, quote one and start with `/new `. Send `/help` for the full list.',
  hintEmpty: 'That quote carried no text, so nothing happened.',
  hintOrphanNew: '`/new` needs a **quoted card**, so I know which workspace the new session inherits.',
  hintEmptyNew: '`/new` needs something after it: what the new session should do.',
  messageReplyFailed: reason => `That instruction did not go out (${String(reason ?? 'no reason given')}). The card can still be answered, or try its input box.`,
  messageNewFailed: 'The new session could not be started (the deployment log has the reason). Check the desk, or try again.',
  messageNotAnAnswer: kind => (kind === 'approval'
    ? 'That is an **approval card**: answer with **`allow`** or **`reject`**. Any other word, and I will not decide it for you.'
    : 'That answer did not fit — the card may be asking a different question now. Take a look and send it again.'),
  messageAnswerGone: 'The request this card was waiting on is no longer open (answered at the desk, cancelled, or the plugin restarted). Nothing was decided.',
  logMessageAnswerFailed: 'answering a card from a chat message failed.',
  logMessageFailed: 'handling a chat message failed.',
  logMessageReplyFailed: 'replying to a chat message failed.',
  logInstructionFailed: 'an instruction sent from a chat message did not reach its session.',
  logMessageNewFailed: 'starting a new session from a chat message failed.',
  logMessageRepeat: 'the platform delivered the same message twice; the repeat was dropped.',
  logMirror: (status, reason) => `desktop mirror: ${status}${reason === undefined ? '' : ` (${reason})`}`,
  logMirrorLapsed: 'a phone decision lapsed before any browser collected it; the composer waiting behind it was left unclosed.',
  logPhonePriority: 'switched to phone priority: later messages no longer wait out the desktop head start.',
  logDeskPriority: 'back to desk priority: messages wait out the desktop head start again.',
  logPriorityStoreFailed: 'the priority could not be saved; it holds for this run, but a restart starts at the desk.',
  logPriorityRestoreFailed: 'reading the saved priority failed; this run starts at the desk.',
  logPriorityListenerFailed: 'handling the priority change failed',
  activityRunning: 'Working',
  activityWaiting: 'Waiting on a tool',
  activityStopped: 'Stopped',
  activityError: 'Failed',
  activityInterrupted: 'Interrupted',
  activityStep: (turn, step) => `turn ${turn} · step ${step}`,
  activityTurn: turn => `turn ${turn}`,
  activityElapsed: seconds => `${seconds}s elapsed`,
  activityTool: name => `**Tool**: \`${name}\``,
  activityFailed: reason => `**Failed**: ${reason}`,
  activityNothingYet: '(no text from this step yet)',
  activityTruncated: 'the output hit its ceiling and stopped, so the work did not finish.',
  activityProcess: 'What this run did',
  activityFrozen: 'Finished',
  activityToolFailed: (name, reason) => `**Tool failed**: \`${name}\`${reason === '' ? '' : ` — ${reason}`}`,
  humanLine: text => `**You**: ${text}`,
  activityTitle: 'Running',
  logActivitySent: 'sent the activity card for this run.',
  logActivitySendFailed: 'sending the activity card failed',
  logActivityUpdateFailed: 'updating the activity card failed',
  logActivityGivenUp: (tries, session) => `gave up maintaining the activity card after ${tries} failed writes (session ${session}); it stays as it last arrived`,
  logDeskSignalSeen: without => `the desk-presence rule is alive: the first human message carrying the gateway's request id arrived (after ${without} without one)`,
  logDeskSignalAbsentSoFar: 'the first human message carried no request id. That alone says nothing about the rule — a message from the phone carries none either — but if messages typed at the desk never carry one, the undeclared upstream field has changed.',
  logSubscribedCallbacks: names => `callback events subscribed for button presses: ${names}`,
  logSubscribedEvents: names => `events subscribed for direct messages: ${names}`,
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
  logProbeRejected: detail => `the liveness probe found Feishu no longer accepts these app credentials (${detail}); closed the long connection — check the app or rebind.`,
  logProbeUnreachable: 'the liveness probe could not reach Feishu (a network problem); leaving the connection state alone.',
  logNoticeFailed: 'sending the result notice failed',
  logNoticeCooling: 'no notice: this session is still inside its cooldown.',
  logNoticeNoAgent: 'no notice: this session has no live agent (this version does not revive a reclaimed session).',
  logNoticeTooLarge: 'the notice read as over the size limit; retrying once at half the text.',
  logNoticeRetrying: attempt => `result delivery attempt ${attempt} failed; retrying shortly.`,
  logNoticeSent: 'the result was sent to the phone.',
  /** Whether the result card carried the run, since a missing fold and an unrecorded run look alike. */
  logRunFold: (session, entries, carried) => carried
    ? `the result card carried the run (${entries} entries).`
    : `the run was empty (${entries} entries), so the card has no fold.`,
  /** The shape of the view the result card was built from, for a report that cannot be seen. */
  logResultView: shape => `result card view: ${shape}`,
  logNoticeSendFailed: 'sending the result failed',
  logNoticeCardFailed: 'rewriting the result card failed',
  logReplyCardRewritten: handle => `rewrote the replied-to result card to say the instruction arrived (message ${handle})`,
  logReplyCardAdopted: handle => `handed the replied-to result card (message ${handle}) to the activity card: this run is shown on that same message instead of a new one`,
  logReplyCardNotRewritten: state => `the reply was accepted but the result card was not rewritten: session=${state.session ? 'yes' : 'no'}, card-as-sent=${state.view ? 'yes' : 'no'}, message=${state.handle || 'none'}`,
  logNoticeRetired: headline => `result notice retired: ${headline}`,
  logNoticeStoreUnavailable: 'durable storage for result notices is unavailable; after a restart these notices will no longer be valid.',
  logNoticeStoreAbsent: 'this deployment composes no durable storage service, so result notices are not kept across a restart.',
  logNoticeStoreReady: 'durable storage for result notices is ready.',
  logNoticeStoreWriteFailed: 'reading or writing a notice record failed',
  logNoticeStoreReadFailed: 'reading the session log to check a result notice failed',
  logNoticeRestoreFailed: 'restoring the result notices from the last run failed',
  logNoticeRestored: count => `restored ${count} result notice(s) from the last run; they still take a reply.`,
  logNoticeStored: rid => `result notice written to durable storage (${rid}).`,
  logNoticeRestoreEmpty: 'the last run left no result notices behind.',
  logNoticeRestoreRetired: (rid, reason) => `restored notice ${rid} was retired: ${reason}`,
  logInstructionQueued: 'the instruction from the phone was queued for the session.',
  logInstructionSteered: 'the session was already running, so the instruction from the phone was steered into its current turn.',
  noticeUnfinished: (kind, why) => {
    const headline = kind === 'max-tokens'
      ? '**The output hit its ceiling** and this turn was cut off before it finished.'
      : '**This turn failed** and did not finish.'
    return why === '' ? headline : `${headline}\n\n${why}`
  },
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
