import { Format, useGuild, useMember, useMention, useMessage, useRequest } from 'alemonjs'
import { getConfig } from './config.js'
import { describe, isOk, logError } from './util.js'

const memberCache = new Map()

let qqbot = null
let qqbotTried = false

/** 直接拿 QQ 官方 SDK 客户端（框架没封装的接口用它兜底） */
async function getQQClient() {
  if (qqbotTried) return qqbot
  qqbotTried = true
  try {
    const mod = await import('@alemonjs/qq-bot')
    const [client] = mod.useClient()
    qqbot = client ?? null
  } catch (err) {
    logError('加载 @alemonjs/qq-bot 失败', err)
    qqbot = null
  }
  return qqbot
}

/** 回复一条文本 */
/** 发送结果里有没有成功的（qq-bot 失败时返回的 code 不是 2000） */
function sentOk(list) {
  if (!Array.isArray(list) || !list.length) return false
  return list.some((item) => item?.code === 2000)
}

export async function reply(text) {
  const [message] = useMessage()
  const list = await message.send({ format: Format.create().addText(String(text)) })
  if (!sentOk(list)) logError('文本发送失败', JSON.stringify(list))
  return list
}

/**
 * 发一条带按钮的消息。
 * 群里带 keyboard 必须走 markdown（msg_type=2），只放 Text 会被官方拒掉。
 */
export async function panelMessage(text, rows) {
  const format = Format.create()
  if (text) {
    const md = Format.createMarkdown()
    md.addContent(String(text))
    format.addMarkdown(md)
  }
  if (rows?.length) {
    const group = Format.createButtonGroup()
    for (const row of rows) {
      group.addRow()
      for (const button of row) group.addButton(button.title, button.data, { type: 'call' })
    }
    format.addButtonGroup(group)
  }
  const [message] = useMessage()
  const list = await message.send({ format })
  if (sentOk(list)) return list

  logError('按钮消息发送失败，降级纯文本', JSON.stringify(list))
  const plain = String(text ?? '').replace(/\*\*/g, '')
  const fallback = rows?.length ? `${plain}\n\n（按钮没发出来，用 #通过 序号 / #拒绝 序号 处理）` : plain
  return message.send({ format: Format.create().addText(fallback) })
}

/** 发一张图 */
export async function sendImage(buffer) {
  const [message] = useMessage()
  const list = await message.send({ format: Format.create().addImage(buffer) })
  if (!sentOk(list)) logError('图片发送失败', JSON.stringify(list))
  return list
}

/** 撤回消息（不传 messageId 则撤回触发消息） */
export async function recall(messageId) {
  const [message] = useMessage()
  const result = await message.delete(messageId ? { messageId } : undefined)
  return isOk(result)
}

/** 机器人群内身份（role: member / admin / owner） */
export async function botRole() {
  const [guild] = useGuild()
  const result = await guild.botInfo()
  if (!isOk(result)) return { ok: false, role: '', reason: describe(result) }
  return { ok: true, role: result.data?.role ?? '', raw: result.data }
}

/** 群当前禁言状态：{ global, members } */
export async function muteState() {
  const [guild] = useGuild()
  const result = await guild.muteState()
  if (!isOk(result)) return { ok: false, reason: describe(result) }
  return { ok: true, global: result.data?.global ?? null, members: result.data?.members ?? [] }
}

/** 群基本信息 */
export async function groupInfo() {
  const [guild] = useGuild()
  const result = await guild.info()
  if (!isOk(result)) return { ok: false, reason: describe(result) }
  return { ok: true, data: result.data }
}

/** 禁言 / 解除禁言单个成员（seconds=0 表示解除） */
export async function muteOne(guildId, userId, seconds) {
  const [member] = useMember()
  const result = await member.mute({ userId, duration: Math.max(0, Math.floor(seconds)), guildId })
  return { ok: isOk(result), result }
}

/** 移出群（不加黑名单） */
export async function kickOne(guildId, userId) {
  const [member] = useMember()
  const result = await member.kick({ userId, guildId })
  return { ok: isOk(result), result }
}

/** 移出群并拉黑 */
export async function banOne(guildId, userId) {
  const [member] = useMember()
  const result = await member.ban({ userId, guildId })
  return { ok: isOk(result), result }
}

/** 解除拉黑 */
export async function unbanOne(guildId, userId) {
  const [member] = useMember()
  const result = await member.unban({ userId, guildId })
  return { ok: isOk(result), result }
}

/** 黑名单列表 */
export async function blacklist() {
  const [member] = useMember()
  const result = await member.blacklist()
  if (!isOk(result)) return { ok: false, reason: describe(result), items: [] }
  return { ok: true, items: result.data?.Items ?? [] }
}

/** 群成员列表（带缓存）。白名单机器人才能用，没权限时 failed=true 并带原因 */
export async function members(guildId, force = false) {
  const config = getConfig()
  const hit = memberCache.get(guildId)
  const ttl = hit?.failed ? 300 : config.memberCacheSeconds
  if (!force && hit && Date.now() - hit.at < ttl * 1000) return hit

  const [member] = useMember()
  const items = []
  let cursor = ''
  for (let page = 0; page < config.memberMaxPages; page += 1) {
    const result = await member.list({ guildId, pagination: { Cursor: cursor, Limit: 30 } })
    if (!isOk(result)) {
      const entry = { at: Date.now(), items: items.length ? items : [], failed: true, reason: describe(result) }
      memberCache.set(guildId, entry)
      return entry
    }
    items.push(...(result.data?.Items ?? []))
    cursor = result.data?.NextCursor ?? ''
    if (!result.data?.HasMore || !cursor) break
  }
  const entry = { at: Date.now(), items, failed: false, reason: '' }
  memberCache.set(guildId, entry)
  return entry
}

/** 清空成员缓存 */
export function clearMemberCache(guildId) {
  if (guildId) memberCache.delete(guildId)
  else memberCache.clear()
}

/** 全员禁言 / 解除（框架的 guild.mute 在群场景直接报不支持，这里直调官方接口） */
export async function setAllMute(guildId, enable) {
  const client = await getQQClient()
  if (!client?.groupsRestrictChatSettingPost) return { ok: false, reason: '当前环境拿不到 QQ 官方接口，无法设置全员禁言' }
  try {
    await client.groupsRestrictChatSettingPost(guildId, { global_rule: { mode: enable ? 'always' : 'none' } })
    return { ok: true }
  } catch (err) {
    const detail = err?.response?.data ?? err?.message ?? err
    return { ok: false, reason: typeof detail === 'string' ? detail : JSON.stringify(detail) }
  }
}

/** 入群申请列表（机器人需是群管理员） */
export async function joinRequests(limit = 10) {
  const [request] = useRequest()
  const result = await request.list({ pagination: { Cursor: '', Limit: limit } })
  if (!isOk(result)) return { ok: false, reason: describe(result), items: [] }
  return { ok: true, items: result.data?.Items ?? [] }
}

/** 审批一条入群申请 */
export async function decideJoin({ userId, requestId, approve, reason, blacklist }) {
  const [request] = useRequest()
  const result = await request.decide({ userId, requestId, approve, reason, blacklist })
  return { ok: isOk(result), result }
}

/** 自动审批策略列表（平台级，按群 openid 绑定） */
export async function joinPolicies() {
  const [request] = useRequest()
  const result = await request.policies.list({ pagination: { Cursor: '', Limit: 20 } })
  if (!isOk(result)) return { ok: false, reason: describe(result), items: [] }
  return { ok: true, items: result.data?.Items ?? [] }
}

/** 开启/关闭本群的入群自动审批 */
export async function setJoinPolicy(guildId, enable) {
  const [request] = useRequest()
  const list = await request.policies.list({ pagination: { Cursor: '', Limit: 50 } })
  if (!isOk(list)) return { ok: false, result: list }
  const hit = (list.data?.Items ?? []).find((item) => (item.guildIds ?? []).includes(guildId))
  if (hit) {
    const result = await request.policies.update({ id: hit.id, enabled: enable })
    return { ok: isOk(result), result }
  }
  if (!enable) return { ok: true, note: '本群还没有自动审批策略，无需关闭' }
  const result = await request.policies.create({ guildIds: [guildId], enabled: true, remark: '群管插件' })
  return { ok: isOk(result), result }
}

/** 当前消息里 @ 的人（官方群默认只收 @机器人 的消息，这里常年为空） */
export async function mentions() {
  try {
    const [mention] = useMention()
    const result = await mention.find()
    if (!result?.data?.length) return []
    return result.data
  } catch {
    return []
  }
}
