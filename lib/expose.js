import { Expose } from 'alemonjs'
import { getQQClient } from './api.js'
import { getConfig, getGroup, bumpStats } from './config.js'
import { logError } from './util.js'

/**
 * 对外暴露的群管能力（插件间协议通信，AI 可通过 schema() 发现）。
 * 读接口默认开放；写接口默认关闭，config.yaml 的 expose.writes 打开后才可用。
 * 统一返回 { status, data?/code+message }，不向调用方抛异常。
 */

function ok(data = {}) {
  return { status: 'success', data }
}

function fail(code, message) {
  return { status: 'error', code, message }
}

function need(value, field) {
  const str = String(value ?? '').trim()
  if (!str) throw new Error(`缺少参数 ${field}`)
  return str
}

function clampSeconds(seconds) {
  const num = Number(seconds)
  const max = getConfig().maxMuteSeconds
  if (!Number.isFinite(num) || num < 0) return 600
  return Math.min(Math.floor(num), max)
}

function writesEnabled() {
  return getConfig().expose.writes === true
}

function writeGuard() {
  if (writesEnabled()) return null
  return fail('WRITES_DISABLED', '写接口未开启。在 config.yaml 的 expose.writes 设为 true 后可用')
}

async function clientOr() {
  const client = await getQQClient()
  if (!client) throw new Error('拿不到 QQ 官方接口客户端')
  return client
}

/** 每个动作都是 async (value) => result，异常统一兜成 fail */
async function run(handler, value) {
  try {
    return await handler(value ?? {})
  } catch (err) {
    logError('expose 调用失败', err)
    return fail('ERROR', String(err?.message ?? err))
  }
}

const read = {
  group_info: {
    description: '查群信息：群名、人数等',
    params: { guildId: '群 openid（必填）' },
    handler: (value) => run(async () => {
      const client = await clientOr()
      const r = await client.groupsInfo(need(value.guildId, 'guildId'))
      return ok({
        guildId: r.group_openid,
        groupName: r.group_name,
        description: r.group_finger_memo,
        memberCount: r.group_member_num
      })
    })
  },
  bot_state: {
    description: '机器人在群里的身份与消息权限',
    params: { guildId: '群 openid（必填）' },
    handler: (value) => run(async () => {
      const client = await clientOr()
      const r = await client.groupsBotState(need(value.guildId, 'guildId'))
      return ok({
        role: r.member_role,
        joinedAt: r.joined_at,
        allowsProactiveMessages: r.allow_proactive_msg,
        receiveMode: r.recv_msg_setting
      })
    })
  },
  mute_state: {
    description: '查全员禁言规则与状态',
    params: { guildId: '群 openid（必填）' },
    handler: (value) => run(async () => {
      const client = await clientOr()
      const r = await client.groupsRestrictChatSetting(need(value.guildId, 'guildId'))
      return ok({ globalRule: r.global_rule ?? null })
    })
  },
  member_list: {
    description: '拉群成员列表（需要成员列表白名单权限，否则 11253）',
    params: { guildId: '群 openid（必填）', cursor: '翻页游标，首页不传' },
    handler: (value) => run(async () => {
      const client = await clientOr()
      const r = await client.groupsMembers(need(value.guildId, 'guildId'), { cursor: String(value.cursor ?? '') })
      return ok({
        members: (r.members ?? []).map((m) => ({ userId: m.member_openid, userName: m.username })),
        hasMore: !!r.has_more
      })
    })
  },
  ban_list: {
    description: '查拉黑名单',
    params: { guildId: '群 openid（必填）' },
    handler: (value) => run(async () => {
      const client = await clientOr()
      const r = await client.groupsMemberBlacklist(need(value.guildId, 'guildId'), { cursor: String(value.cursor ?? '') })
      return ok({
        users: (r.users ?? []).map((m) => ({ userId: m.member_openid, userName: m.username, isBot: !!m.bot })),
        hasMore: !!r.has_more
      })
    })
  },
  join_requests: {
    description: '查待审批的入群申请（机器人需是群管理员）',
    params: { guildId: '群 openid（必填）' },
    handler: (value) => run(async () => {
      const client = await clientOr()
      const r = await client.groupsJoinRequestList(need(value.guildId, 'guildId'), { cursor: String(value.cursor ?? '') })
      return ok({
        items: (r.list ?? []).map((item) => ({
          requestId: item.join_request_id,
          userId: item.member_openid,
          userName: item.username,
          verifyMessage: item.verify_info?.verify_message ?? '',
          risk: item.risk_tips ?? ''
        })),
        hasMore: !!r.has_more
      })
    })
  },
  stats: {
    description: '查本群累计处置统计（禁言/踢人/审批次数）',
    params: { guildId: '群 openid（必填）' },
    handler: (value) => run(async () => ok({ stats: getGroup(need(value.guildId, 'guildId')).stats }))
  }
}

const write = {
  mute: {
    description: '禁言一个成员（时长受 maxMuteSeconds 限制）',
    params: { guildId: '群 openid', userId: '成员 openid', seconds: '时长秒数，默认 600' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const guildId = need(value.guildId, 'guildId')
      const userId = need(value.userId, 'userId')
      const seconds = clampSeconds(value.seconds)
      const client = await clientOr()
      await client.groupsRestrictChatSettingPost(guildId, {
        members: [{ member_openid: userId, op: 'add', mute_expire_at: new Date(Date.now() + seconds * 1000).toISOString() }]
      })
      bumpStats(guildId, 'muted')
      return ok({ userId, seconds })
    })
  },
  unmute: {
    description: '解除成员禁言',
    params: { guildId: '群 openid', userId: '成员 openid' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const guildId = need(value.guildId, 'guildId')
      const userId = need(value.userId, 'userId')
      const client = await clientOr()
      await client.groupsRestrictChatSettingPost(guildId, { members: [{ member_openid: userId, op: 'del', mute_expire_at: '' }] })
      return ok({ userId })
    })
  },
  kick: {
    description: '把成员移出群聊',
    params: { guildId: '群 openid', userId: '成员 openid' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const guildId = need(value.guildId, 'guildId')
      const userId = need(value.userId, 'userId')
      const client = await clientOr()
      await client.groupsBatchRemoveMembers(guildId, { member_openids: [userId] })
      bumpStats(guildId, 'kicked')
      return ok({ userId })
    })
  },
  ban: {
    description: '移出群聊并拉黑',
    params: { guildId: '群 openid', userId: '成员 openid' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const guildId = need(value.guildId, 'guildId')
      const userId = need(value.userId, 'userId')
      const client = await clientOr()
      await client.groupsBatchRemoveMembers(guildId, { member_openids: [userId], add_to_member_blacklist: true })
      bumpStats(guildId, 'kicked')
      return ok({ userId })
    })
  },
  unban: {
    description: '解除拉黑',
    params: { guildId: '群 openid', userId: '成员 openid' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const guildId = need(value.guildId, 'guildId')
      const userId = need(value.userId, 'userId')
      const client = await clientOr()
      await client.groupsMemberBlacklistPost(guildId, { op: 'del', member_openids: [userId] })
      return ok({ userId })
    })
  },
  set_all_mute: {
    description: '开启/关闭全员禁言',
    params: { guildId: '群 openid', enable: 'true 开 / false 关' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const guildId = need(value.guildId, 'guildId')
      const enable = value.enable === true || value.enable === 'true'
      const client = await clientOr()
      await client.groupsRestrictChatSettingPost(guildId, { global_rule: { mode: enable ? 'always' : 'none' } })
      return ok({ enable })
    })
  },
  approve_join: {
    description: '通过一条入群申请',
    params: { guildId: '群 openid', userId: '申请人 openid', requestId: '申请 ID（join_requests 里拿）' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const guildId = need(value.guildId, 'guildId')
      const userId = need(value.userId, 'userId')
      const requestId = need(value.requestId, 'requestId')
      const client = await clientOr()
      await client.groupsApprovalJoinRequest(guildId, userId, { op: 'approve', join_request_id: requestId })
      bumpStats(guildId, 'approved')
      return ok({ userId, requestId })
    })
  },
  reject_join: {
    description: '拒绝一条入群申请，可附理由',
    params: { guildId: '群 openid', userId: '申请人 openid', requestId: '申请 ID', reason: '拒绝理由' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const guildId = need(value.guildId, 'guildId')
      const userId = need(value.userId, 'userId')
      const requestId = need(value.requestId, 'requestId')
      const client = await clientOr()
      await client.groupsApprovalJoinRequest(guildId, userId, {
        op: 'decline',
        join_request_id: requestId,
        reject_reason: String(value.reason ?? '')
      })
      bumpStats(guildId, 'rejected')
      return ok({ userId, requestId })
    })
  }
}

export const expose = Expose.create().provide({
  name: 'qq-group-admin',
  description: 'QQ 官方机器人群管能力：禁言/踢人/拉黑/入群审批/群信息。读接口随时可用，写接口需在 config.yaml 开 expose.writes',
  actions: { ...read, ...write }
})
