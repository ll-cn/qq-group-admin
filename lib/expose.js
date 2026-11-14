import { useEvent, useGuild, useMember, useRequest, Expose } from 'alemonjs'
import { getGroup, bumpStats } from './config.js'
import { HELP_SECTIONS, HELP_TEXT } from './help.js'
import { PLUGIN_NAME, VERSION } from './version.js'
import { logError } from './util.js'
import * as configModule from './config.js'

/**
 * 对外暴露的群管能力（插件间协议通信，AI 可通过 schema() 发现）。
 * 全部走框架标准动作（hooks），群与身份取自调用方的消息上下文；
 * 读接口默认开放，写接口默认关闭（expose.writes）。
 * 统一返回 { status: 'success', data } / { status: 'error', code, message }，不向调用方抛异常。
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
  const max = configModule.getConfig().maxMuteSeconds
  if (!Number.isFinite(num) || num < 0) return 600
  return Math.min(Math.floor(num), max)
}

function writeGuard() {
  if (configModule.getConfig().expose.writes === true) return null
  return fail('WRITES_DISABLED', '写接口未开启。在 config.yaml 的 expose.writes 设为 true 后可用')
}

/** 调用方消息上下文里的群 openid；不在消息上下文时抛错 */
function contextGuildId() {
  const [ref] = useEvent()
  const gid = String(ref?.current?.GuildId ?? '')
  if (!gid) throw new Error('调用须在群消息上下文中进行（拿不到群标识）')
  return gid
}

async function run(handler, value) {
  try {
    return await handler(value ?? {})
  } catch (err) {
    logError('expose 调用失败', err)
    return fail('ERROR', String(err?.message ?? err))
  }
}

const read = {
  help: {
    description: '列出本插件的全部群管指令与对外动作，返回可直接朗读的纯文本说明（text 字段），AI 用它回答「群管插件怎么用」',
    handler: () => run(async () => ok({
      name: PLUGIN_NAME,
      version: VERSION,
      prefixes: ['#', '＃', '/', '!', '！'],
      helpCommand: '#群管帮助（要纯文本可发 #群管帮助 文字）',
      text: HELP_TEXT,
      commands: HELP_SECTIONS.map((section) => ({
        section: section.title,
        items: section.items.map(([command, description]) => ({ command, description }))
      })),
      actions: Object.keys({ ...read, ...write })
    }))
  },
  group_info: {
    description: '查群信息：群名、人数等',
    handler: (value) => run(async () => {
      const gid = contextGuildId()
      const [guild] = useGuild()
      const result = await guild.info({ guildId: gid })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '查询失败'))
      return ok({
        guildId: gid,
        groupName: result.data?.GuildName ?? result.data?.groupName,
        description: result.data?.Description ?? result.data?.description,
        memberCount: result.data?.MemberCount ?? result.data?.memberCount
      })
    })
  },
  bot_state: {
    description: '机器人在群里的身份与消息权限',
    handler: (value) => run(async () => {
      const gid = contextGuildId()
      const [guild] = useGuild()
      const result = await guild.botInfo({ guildId: gid })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '查询失败'))
      return ok({
        role: result.data?.role ?? result.data?.Role,
        receiveMode: result.data?.receiveMode ?? result.data?.ReceiveMode
      })
    })
  },
  mute_state: {
    description: '查本群禁言相关状态',
    handler: (value) => run(async () => {
      const gid = contextGuildId()
      const [guild] = useGuild()
      const result = await guild.muteState({ guildId: gid })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '查询失败'))
      return ok({ global: result.data?.global ?? null, members: result.data?.members ?? [] })
    })
  },
  member_list: {
    description: '拉群成员列表（需要成员列表白名单权限，否则 11253）',
    params: { cursor: '翻页游标，首页不传' },
    handler: (value) => run(async () => {
      const gid = contextGuildId()
      const [member] = useMember()
      const result = await member.list({ guildId: gid, pagination: { Cursor: String(value?.cursor ?? ''), Limit: 30 } })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '查询失败'))
      return ok({
        members: (result.data?.Items ?? []).map((item) => ({ userId: item.UserId ?? item.userId, userName: item.UserName ?? item.username })),
        hasMore: !!result.data?.HasMore
      })
    })
  },
  member_info: {
    description: '查单个成员的信息（昵称、角色、入群时间）',
    params: { userId: '成员 openid（必填）' },
    handler: (value) => run(async () => {
      const gid = contextGuildId()
      const uid = need(value?.userId, 'userId')
      const [member] = useMember()
      const result = await member.info({ userId: uid, guildId: gid })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '查询失败'))
      return ok({
        userId: uid,
        userName: result.data?.Nickname ?? result.data?.UserName ?? result.data?.userName,
        role: result.data?.Role ?? result.data?.role,
        joinedAt: result.data?.JoinedAt ?? result.data?.joinedAt
      })
    })
  },
  ban_list: {
    description: '查拉黑名单',
    handler: (value) => run(async () => {
      const gid = contextGuildId()
      const [member] = useMember()
      const result = await member.blacklist({ pagination: { Cursor: String(value?.cursor ?? ''), Limit: 30 } })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '查询失败'))
      return ok({
        users: (result.data?.Items ?? []).map((item) => ({ userId: item.UserId ?? item.userId, userName: item.UserName ?? item.username, isBot: !!item.IsBot }))
      })
    })
  },
  join_requests: {
    description: '查待审批的入群申请（机器人需是群管理员）',
    handler: (value) => run(async () => {
      contextGuildId()
      const [request] = useRequest()
      const result = await request.list({ pagination: { Cursor: String(value?.cursor ?? ''), Limit: 30 } })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '查询失败'))
      return ok({
        items: (result.data?.Items ?? []).map((item) => ({
          requestId: item.id ?? item.requestId,
          userId: item.userId,
          userName: item.userName,
          verifyMessage: item.verification?.message ?? ''
        }))
      })
    })
  },
  stats: {
    description: '查本群累计处置统计（禁言/踢人/审批次数）',
    handler: (value) => run(async () => {
      const gid = contextGuildId()
      return ok({ stats: getGroup(gid).stats })
    })
  }
}

const write = {
  mute: {
    description: '禁言一个成员（时长受 maxMuteSeconds 限制）',
    params: { userId: '成员 openid', seconds: '时长秒数，默认 600' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const gid = contextGuildId()
      const uid = need(value?.userId, 'userId')
      const seconds = clampSeconds(value?.seconds)
      const [member] = useMember()
      const result = await member.mute({ userId: uid, duration: seconds, guildId: gid })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '禁言失败'))
      bumpStats(gid, 'muted')
      return ok({ userId: uid, seconds })
    })
  },
  unmute: {
    description: '解除成员禁言',
    params: { userId: '成员 openid' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const gid = contextGuildId()
      const uid = need(value?.userId, 'userId')
      const [member] = useMember()
      const result = await member.mute({ userId: uid, duration: 0, guildId: gid })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '解除失败'))
      return ok({ userId: uid })
    })
  },
  kick: {
    description: '把成员移出群聊',
    params: { userId: '成员 openid' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const gid = contextGuildId()
      const uid = need(value?.userId, 'userId')
      const [member] = useMember()
      const result = await member.kick({ userId: uid, guildId: gid })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '踢人失败'))
      bumpStats(gid, 'kicked')
      return ok({ userId: uid })
    })
  },
  ban: {
    description: '移出群聊并拉黑',
    params: { userId: '成员 openid' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const gid = contextGuildId()
      const uid = need(value?.userId, 'userId')
      const [member] = useMember()
      const result = await member.ban({ userId: uid, guildId: gid })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '拉黑失败'))
      bumpStats(gid, 'kicked')
      return ok({ userId: uid })
    })
  },
  unban: {
    description: '解除拉黑',
    params: { userId: '成员 openid' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const gid = contextGuildId()
      const uid = need(value?.userId, 'userId')
      const [member] = useMember()
      const result = await member.unban({ userId: uid, guildId: gid })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '解除失败'))
      return ok({ userId: uid })
    })
  },
  approve_join: {
    description: '通过一条入群申请',
    params: { userId: '申请人 openid', requestId: '申请 ID（join_requests 里拿）' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const gid = contextGuildId()
      const uid = need(value?.userId, 'userId')
      const requestId = need(value?.requestId, 'requestId')
      const [request] = useRequest()
      const result = await request.decide({ userId: uid, requestId, approve: true })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '审批失败'))
      bumpStats(gid, 'approved')
      return ok({ userId: uid, requestId })
    })
  },
  reject_join: {
    description: '拒绝一条入群申请，可附理由',
    params: { userId: '申请人 openid', requestId: '申请 ID', reason: '拒绝理由' },
    handler: (value) => run(async () => {
      const denied = writeGuard()
      if (denied) return denied
      const gid = contextGuildId()
      const uid = need(value?.userId, 'userId')
      const requestId = need(value?.requestId, 'requestId')
      const [request] = useRequest()
      const result = await request.decide({ userId: uid, requestId, approve: false, reason: String(value?.reason ?? '') })
      if (!result || result.code !== 2000) return fail('API_FAILED', String(result?.message ?? '审批失败'))
      bumpStats(gid, 'rejected')
      return ok({ userId: uid, requestId })
    })
  }
}

export const expose = Expose.create().provide({
  name: 'qq-group-admin',
  description: 'QQ 官方机器人群管插件：禁言/解禁/踢人/拉黑/入群审批/群信息/成员统计。群聊指令前缀 # 或 / 均可（例：#禁言 @他 10m、/群管帮助），完整用法调本协议的 help 动作（返回可直接朗读的纯文本）。读接口随时可用，写接口默认开启（config 的 expose.writes 可关）。动作需在群消息上下文中调用',
  actions: { ...read, ...write }
})
