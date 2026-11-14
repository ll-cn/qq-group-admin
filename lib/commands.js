import { useEvent, useRoute } from 'alemonjs'
import {
  banOne, blacklist, botRole, clearMemberCache, decideJoin, groupInfo, joinPolicies, joinRequests,
  kickOne, members, muteOne, muteState, panelMessage, recall, reply, setAllMute, setJoinPolicy, unbanOne
} from './api.js'
import { isOk } from './util.js'
import { useMember } from 'alemonjs'
import { bumpStats, getConfig, getGroup, saveGroup } from './config.js'

import { lookupName, rememberName } from './nick.js'
import { recordDenied } from './denied.js'
import { flushSpeak, lastSpeakAt, rememberSpeak, speakSince } from './speak.js'
import { sendHelp } from './help.js'
import { clampSeconds, pickDuration, resolveTargets } from './target.js'
import { describe, formatDuration, logError, logInfo } from './util.js'

/** 当前事件 */
function event() {
  const [ref] = useEvent({ selects: ['message.create', 'private.message.create'] })
  return ref.current ?? {}
}

/** 指令后面的参数 */
function readArgs() {
  const [route] = useRoute()
  return route.matched ? [...route.rawArgs] : []
}

/** 群号（官方群场景下就是 group_openid） */
function guildId() {
  return event().GuildId ?? ''
}

/** 事件里带的群内角色（全量消息模式下才有） */
function roleOf(evt) {
  return evt?.value?.author?.member_role ?? evt?.MemberRole ?? ''
}

/** 是否有管理权限：主人 / 配置白名单 / 群主 / 群管理员 */
export function canManage(evt = event()) {
  if (evt?.IsMaster) return true
  const uid = evt?.UserId
  if (uid) {
    if (getConfig().admins.includes(uid)) return true
    if (getGroup(evt.GuildId ?? '').admins.includes(uid)) return true
  }
  const role = roleOf(evt)
  return role === 'admin' || role === 'owner'
}

/**
 * 用成员列表接口核对点击者/发言者是不是群管理员或群主。
 * 官方交互事件只带 openid 不带身份，这是唯一能查平台侧角色的途径；
 * 成员列表接口要白名单权限，没权限（11253）时返回 false 走原有判定。
 */
async function isAdminByMemberList(evt = event()) {
  const gid = String(evt?.GuildId ?? '')
  const uid = String(evt?.UserId ?? '')
  if (!gid || !uid) return false
  try {
    const res = await members(gid)
    if (res.failed) return false
    const item = res.items.find((member) => String(member.UserId) === uid)
    const role = String(item?.Role ?? '')
    return role === 'admin' || role === 'owner'
  } catch {
    return false
  }
}

/**
 * 单个成员信息接口兜底：成员列表接口被拒（11253）时，这条的权限 scope 是分开的，
 * 有些机器人能过。返回里带 member_role，能查到就按平台侧角色判定。
 */
async function isAdminByMemberInfo(evt = event()) {
  const gid = String(evt?.GuildId ?? '')
  const uid = String(evt?.UserId ?? '')
  if (!gid || !uid) return false
  try {
    const [member] = useMember()
    const result = await member.info({ userId: uid, guildId: gid })
    if (!isOk(result)) return false
    const role = String(result.data?.Role ?? result.data?.role ?? '')
    return role === 'admin' || role === 'owner'
  } catch {
    return false
  }
}

/** 无权限时回一句并返回 false */
async function requireAdmin() {
  const evt = event()
  if (canManage(evt)) return true
  if (await isAdminByMemberList(evt)) return true
  if (await isAdminByMemberInfo(evt)) return true
  recordDenied(evt?.UserId, evt?.GuildId)
  logInfo(`权限不足：openid=${evt?.UserId}（已记入待授权列表，主人可在面板一键授权）`)
  await reply('这个指令只有群管理员能用。')
  return false
}

/**
 * 声明式权限校验（对标 Yunzai 的 rule permission）：
 * 指令和按钮在注册时声明 permission，分发前统一在这里校验。
 * admin = 四级判定（事件角色/主人/admins/平台侧角色）；all = 任何人可用。
 */
export async function checkPermission(permission = 'admin') {
  if (permission === 'all') return true
  if (permission === 'admin') return requireAdmin()
  logError(`未知的 permission：${permission}`)
  return false
}

export async function help() {
  await sendHelp()
}

/** 按钮面板：点一下直接执行 */
export async function panel() {
  if (!(await requireAdmin())) return
  await panelMessage('群管面板，点按钮直接执行：', [
    [{ title: '禁言状态', data: '禁言状态' }, { title: '群成员', data: '群成员' }],
    [{ title: '全员禁言', data: '全员禁言' }, { title: '解除全员禁言', data: '解除全员禁言' }],
    [{ title: '群信息', data: '群信息' }, { title: '群管帮助', data: '群管帮助' }]
  ])
}

/** 禁言 / 解禁 */
export async function punish(unban) {
  if (!(await requireAdmin())) return
  const config = getConfig()
  const rawArgs = readArgs()
  const duration = unban ? { seconds: 0, rest: rawArgs } : pickDuration(rawArgs)
  const gid = guildId()

  const { targets, error } = await resolveTargets(gid, duration.rest)
  if (error) return reply(error)

  const role = await botRole()
  if (role.ok && role.role === 'member') {
    return reply('我在这个群里还不是管理员，禁言会被官方接口直接拒。请先把我设成群管理员。')
  }

  const done = []
  const failed = []
  for (const item of targets) {
    const res = await muteOne(gid, item.userId, unban ? 0 : duration.seconds)
    if (res.ok) done.push(item)
    else failed.push({ ...item, reason: describe(res.result) })
  }

  if (done.length && !unban) bumpStats(gid, 'muted', done.length)
  await reply(await buildReport({ unban, seconds: duration.seconds, done, failed, verify: config.verifyAfterMute }))
}

/** 处置结果 + 生效校验 */
async function buildReport({ unban, seconds, done, failed, verify }) {
  const lines = []
  if (done.length) lines.push(`${unban ? '已解除禁言' : `已禁言 ${formatDuration(seconds)}`}：${done.map((item) => item.name).join('、')}`)
  if (failed.length) lines.push(`失败：${failed.map((item) => `${item.name}（${item.reason}）`).join('；')}`)
  if (!done.length || !verify) return lines.join('\n') || '没有可处理的对象'

  const state = await muteState()
  if (!state.ok) {
    lines.push(`生效校验没做成：${state.reason}`)
    return lines.join('\n')
  }
  const muted = new Set((state.members ?? []).map((item) => item.userId))
  const wrong = done.filter((item) => (unban ? muted.has(item.userId) : !muted.has(item.userId)))
  if (!wrong.length) lines.push('生效校验：确认生效')
  else lines.push(`生效校验：${wrong.map((item) => item.name).join('、')} 状态没变，对方可能是管理员或群主（官方不允许处置）`)
  return lines.join('\n')
}

/** 禁言状态 */
export async function muteStatus() {
  if (!(await requireAdmin())) return
  const state = await muteState()
  if (!state.ok) return reply(`查不到禁言状态：${state.reason}`)
  const lines = []
  const mode = state.global?.mode ?? 'none'
  lines.push(`全员：${mode === 'always' ? '禁言中' : mode === 'schedule' ? '定时禁言' : '未开启'}`)
  const list = state.members ?? []
  if (!list.length) lines.push('成员禁言：暂无')
  else {
    lines.push(`成员禁言（${list.length} 人）：`)
    for (const item of list.slice(0, 20)) {
      const name = item.userName || item.userId?.slice(0, 8) || '未知'
      const left = item.expiresAt ? Math.max(0, Math.round((new Date(item.expiresAt).getTime() - Date.now()) / 1000)) : 0
      lines.push(`· ${name} 剩 ${formatDuration(left)}`)
    }
    if (list.length > 20) lines.push(`…还有 ${list.length - 20} 人`)
  }
  await reply(lines.join('\n'))
}

/** 全员禁言 */
export async function allMute(enable) {
  if (!(await requireAdmin())) return
  const res = await setAllMute(guildId(), enable)
  if (!res.ok) return reply(`设置失败：${res.reason}`)
  await reply(enable ? '已开启全员禁言。' : '已解除全员禁言。')
}

/** 踢人 / 拉黑 / 解除拉黑 */
export async function memberAction(kind) {
  if (!(await requireAdmin())) return
  const gid = guildId()
  const { targets, error } = await resolveTargets(gid, readArgs())
  if (error) return reply(error)

  const done = []
  const failed = []
  for (const item of targets) {
    const res = kind === 'kick' ? await kickOne(gid, item.userId) : kind === 'ban' ? await banOne(gid, item.userId) : await unbanOne(gid, item.userId)
    if (res.ok) done.push(item)
    else failed.push({ ...item, reason: describe(res.result) })
  }
  if (done.length && kind !== 'unban') bumpStats(gid, 'kicked', done.length)

  const label = kind === 'kick' ? '已移出群' : kind === 'ban' ? '已移出并拉黑' : '已解除拉黑'
  const lines = []
  if (done.length) lines.push(`${label}：${done.map((item) => item.name).join('、')}`)
  if (failed.length) lines.push(`失败：${failed.map((item) => `${item.name}（${item.reason}）`).join('；')}`)
  await reply(lines.join('\n') || '没有可处理的对象')
}

/** 黑名单 */
export async function banList() {
  if (!(await requireAdmin())) return
  const res = await blacklist()
  if (!res.ok) return reply(`查不到黑名单：${res.reason}`)
  if (!res.items.length) return reply('黑名单是空的。')
  const lines = [`黑名单（${res.items.length} 人）：`]
  for (const item of res.items.slice(0, 20)) lines.push(`· ${item.userName || item.userId?.slice(0, 8)}`)
  if (res.items.length > 20) lines.push(`…还有 ${res.items.length - 20} 人`)
  await reply(lines.join('\n'))
}

/** 群成员 */
export async function memberList() {
  if (!(await requireAdmin())) return
  const gid = guildId()
  const withOpenId = readArgs().some((arg) => /^(openid|id|完整)$/i.test(arg))
  const res = await members(gid, withOpenId)
  if (!res.items.length) return reply(`拉不到群成员列表：${res.reason}\n这个接口需要白名单权限，拉不到时可以直接用 openid 指定对象。`)
  const lines = [`群成员（已取 ${res.items.length} 人${withOpenId ? '，含 openid' : ''}）：`]
  res.items.slice(0, 25).forEach((item, index) => {
    const role = item.Role === 'owner' ? ' [群主]' : item.Role === 'admin' ? ' [管理]' : ''
    lines.push(`${index + 1}. ${item.UserName || '（无昵称）'}${role}${withOpenId && item.UserId ? ` ${item.UserId}` : ''}`)
  })
  if (res.items.length > 25) lines.push(`…还有 ${res.items.length - 25} 人`)
  if (!withOpenId) lines.push('要完整 openid 请发「#群成员 openid」')
  await reply(lines.join('\n'))
}

/** 群信息 */
export async function info() {
  const gid = guildId()
  const group = getGroup(gid)
  const lines = []
  const res = await groupInfo()
  if (res.ok) {
    const data = res.data ?? {}
    lines.push(`群名：${data.GuildName ?? data.name ?? '未知'}`)
    if (data.MemberCount) lines.push(`人数：${data.MemberCount}`)
  } else {
    lines.push(`群信息：${res.reason}`)
  }
  const role = await botRole()
  lines.push(`我的身份：${role.ok ? roleText(role.role) : `查询失败（${role.reason}）`}`)
  const state = await muteState()
  lines.push(`全员禁言：${state.ok ? (state.global?.mode === 'always' ? '开' : '关') : '查不到'}`)
  lines.push(`自动群管：${group.auto.enabled ? '开' : '关'}`)
  lines.push(`本群累计：禁言 ${group.stats.muted ?? 0} 次、移出 ${group.stats.kicked ?? 0} 次`)
  await reply(lines.join('\n'))
}

function roleText(role) {
  if (role === 'owner') return '群主'
  if (role === 'admin') return '管理员'
  if (role === 'member') return '普通成员（没有管理权限）'
  return role || '未知'
}

/** 撤回自己上一条消息 */
export async function recallSelf() {
  if (!(await requireAdmin())) return
  const ok = await recall()
  if (!ok) await reply('撤回失败。官方接口只能撤回我自己发的消息。')
}

/** 自动群管开关 */
export async function toggleAuto() {
  if (!(await requireAdmin())) return
  const gid = guildId()
  const group = getGroup(gid)
  const word = (readArgs()[0] ?? '').toLowerCase()
  if (!word) {
    return reply(`自动群管：${group.auto.enabled ? '开' : '关'}\n发送「#群管开关 开」或「#群管开关 关」切换。`)
  }
  const enable = ['开', 'on', '开启', '1', 'true'].includes(word)
  const disable = ['关', 'off', '关闭', '0', 'false'].includes(word)
  if (!enable && !disable) return reply('用法：#群管开关 开 ｜ #群管开关 关')
  const next = saveGroup(gid, { auto: { ...group.auto, enabled: enable } })
  await reply(`自动群管已${next.auto.enabled ? '开启' : '关闭'}。`)
}

/** 违禁词管理 */
export async function badWords() {
  if (!(await requireAdmin())) return
  const gid = guildId()
  const group = getGroup(gid)
  const args = readArgs()
  const action = args[0] ?? ''
  const value = args.slice(1).join(' ').trim()

  if (!action) {
    if (!group.auto.words.length) return reply('违禁词是空的。\n添加：#违禁词 添加 词')
    return reply(`违禁词（${group.auto.words.length} 个）：\n${group.auto.words.join('、')}`)
  }
  if (action === '添加' || action === 'add') {
    if (!value) return reply('用法：#违禁词 添加 关键词')
    if (group.auto.words.includes(value)) return reply(`「${value}」已经在列表里了。`)
    const words = [...group.auto.words, value]
    saveGroup(gid, { auto: { ...group.auto, words } })
    return reply(`已添加违禁词「${value}」，当前 ${words.length} 个。`)
  }
  if (action === '删除' || action === 'del' || action === 'remove') {
    if (!value) return reply('用法：#违禁词 删除 关键词')
    const words = group.auto.words.filter((word) => word !== value)
    saveGroup(gid, { auto: { ...group.auto, words } })
    return reply(`已删除「${value}」，当前 ${words.length} 个。`)
  }
  if (action === '清空' || action === 'clear') {
    saveGroup(gid, { auto: { ...group.auto, words: [] } })
    return reply('违禁词已清空。')
  }
  return reply('用法：#违禁词 ｜ #违禁词 添加 词 ｜ #违禁词 删除 词 ｜ #违禁词 清空')
}

/** 刷屏阈值设置 */
export async function floodSetting() {
  if (!(await requireAdmin())) return
  const gid = guildId()
  const group = getGroup(gid)
  const numbers = readArgs().map((arg) => Number(arg)).filter((num) => Number.isFinite(num) && num >= 0)
  if (numbers.length < 2) {
    const auto = group.auto
    return reply([
      `当前刷屏规则：${auto.floodSeconds} 秒内超过 ${auto.floodCount} 条 → 禁言 ${formatDuration(auto.floodMuteSeconds)}`,
      `违禁词命中 → 禁言 ${formatDuration(auto.bannedMuteSeconds)}`,
      '修改：#刷屏设置 <窗口秒> <条数> [禁言秒]'
    ].join('\n'))
  }
  const next = {
    ...group.auto,
    floodSeconds: Math.max(1, Math.floor(numbers[0])),
    floodCount: Math.max(2, Math.floor(numbers[1])),
    floodMuteSeconds: numbers.length > 2 ? clampSeconds(numbers[2], getConfig()) : group.auto.floodMuteSeconds
  }
  saveGroup(gid, { auto: next })
  await reply(`已更新：${next.floodSeconds} 秒内超过 ${next.floodCount} 条 → 禁言 ${formatDuration(next.floodMuteSeconds)}`)
}

/** 清理成员缓存 */
export async function refreshMembers() {
  if (!(await requireAdmin())) return
  clearMemberCache(guildId())
  await reply('成员缓存已清空，下次查询会重新拉取。')
}

/** 待审批申请的序号缓存（每次 #入群申请 刷新） */
const pendingMap = new Map()

/** 入群申请列表 */
export async function joinList() {
  if (!(await requireAdmin())) return
  const gid = guildId()
  const want = Number(readArgs()[0])
  const limit = Number.isFinite(want) && want > 0 ? Math.min(Math.floor(want), 50) : 10
  const res = await joinRequests(limit)
  if (!res.ok) return reply(`拉不到入群申请：${res.reason}\n这个接口同样要求机器人是群管理员。`)
  if (!res.items.length) {
    pendingMap.delete(gid)
    return reply('当前没有待审批的入群申请。')
  }
  pendingMap.set(gid, res.items)
  for (const item of res.items) rememberName(gid, item.userId, item.userName)
  const lines = [`**待审批 ${res.items.length} 人**`, '']
  res.items.forEach((item, index) => {
    const name = item.userName || String(item.userId ?? '').slice(0, 8)
    const verify = item.verification?.message ? `｜${item.verification.message}` : ''
    const risk = item.risk ? `｜⚠${item.risk}` : ''
    lines.push(`${index + 1}. ${name}${verify}${risk}`)
  })

  const rows = res.items.slice(0, 5).map((item, index) => ([
    { title: `通过 ${index + 1}`, data: `join_ok:${item.id}:${item.userId}` },
    { title: `拒绝 ${index + 1}`, data: `join_no:${item.id}:${item.userId}` }
  ]))
  if (res.items.length > 5) lines.push('', '超过 5 人时按钮只覆盖前 5 位，其余用 #通过 序号')
  lines.push('', '也可以直接发：#通过 序号 ｜ #拒绝 序号 [理由]')
  await panelMessage(lines.join('\n'), rows)
}

/** 通过 / 拒绝入群申请（序号来自 #入群申请） */
export async function joinDecide(approve) {
  if (!(await requireAdmin())) return
  const gid = guildId()
  const args = readArgs()
  const index = Number(args[0])
  const list = pendingMap.get(gid)
  if (!list?.length) return reply('先发「#入群申请」拉一次列表，再按序号审批。')
  if (!Number.isInteger(index) || index < 1 || index > list.length) return reply(`序号要在 1-${list.length} 之间`)
  const target = list[index - 1]
  const reason = args.slice(1).join(' ').trim()
  const res = await decideJoin({ userId: target.userId, requestId: target.id, approve, reason: approve ? undefined : reason })
  if (!res.ok) return reply(`审批失败：${describe(res.result)}`)
  list.splice(index - 1, 1)
  pendingMap.set(gid, list)
  bumpStats(gid, approve ? 'approved' : 'rejected')
  await reply(`${approve ? '已通过' : '已拒绝'} ${target.userName || String(target.userId ?? '').slice(0, 8)} 的入群申请。`)
}

/** 入群自动审批策略（平台级，绑定到群 openid） */
export async function joinPolicy() {
  if (!(await requireAdmin())) return
  const gid = guildId()
  const word = (readArgs()[0] ?? '').toLowerCase()
  if (!word) {
    const res = await joinPolicies()
    if (!res.ok) return reply(`查不到审批策略：${res.reason}`)
    const hit = res.items.find((item) => (item.guildIds ?? []).includes(gid))
    if (!hit) return reply('本群没有单独的自动审批策略。\n开启：#自动审批 开')
    return reply(`自动审批：${hit.enabled ? '开' : '关'}\n策略ID：${hit.id}${hit.remark ? `\n备注：${hit.remark}` : ''}`)
  }
  const enable = ['开', 'on', '开启', '1'].includes(word)
  const disable = ['关', 'off', '关闭', '0'].includes(word)
  if (!enable && !disable) return reply('用法：#自动审批 ｜ #自动审批 开 ｜ #自动审批 关')
  const res = await setJoinPolicy(gid, enable)
  if (!res.ok) return reply(`设置失败：${describe(res.result ?? res)}`)
  await reply(res.note ?? `自动审批已${enable ? '开启' : '关闭'}。`)
}

/** 从按钮 data 审批：join_ok:<requestId>:<openid>。只有管理员/主人能点 */
async function decideFromButton(key, approve) {
  if (!(await checkPermission('admin'))) return true
  const [, requestId, userId] = key.split(':')
  if (!requestId || !userId) return false
  const res = await decideJoin({ userId, requestId, approve })
  if (!res.ok) {
    await reply(`审批失败：${describe(res.result)}`)
    return true
  }
  bumpStats(guildId(), approve ? 'approved' : 'rejected')
  await reply(approve ? '已通过这条入群申请。' : '已拒绝这条入群申请。')
  return true
}

/** 按钮回调：button_data 就是这里的分发键，每个按钮声明 permission */
const BUTTON_MAP = {
  禁言状态: { permission: 'admin', run: () => muteStatus() },
  群成员: { permission: 'admin', run: () => memberList() },
  全员禁言: { permission: 'admin', run: () => allMute(true) },
  解除全员禁言: { permission: 'admin', run: () => allMute(false) },
  群信息: { permission: 'admin', run: () => info() },
  群管帮助: { permission: 'all', run: () => help() }
}

export async function onButton(event, next) {
  if (!String(event?.name ?? '').includes('interaction')) return typeof next === 'function' ? next() : undefined
  const key = String(event?.MessageText ?? '')
    .trim()
    .replace(/^notAutoConfirmation:/, '')
    .replace(/^[#＃/!！]/, '')
  if (key.startsWith('join_ok:')) return decideFromButton(key, true)
  if (key.startsWith('join_no:')) return decideFromButton(key, false)
  const entry = BUTTON_MAP[key]
  if (!entry) return typeof next === 'function' ? next() : undefined
  if (!(await checkPermission(entry.permission))) return true
  await entry.run()
  return true
}

/** ==================== 未发言查看 / 清理 ==================== */

const pendingCleanup = new Map()
const CLEANUP_TTL = 5 * 60 * 1000
const KICK_BATCH = 20

/** 解析未发言命令：返回 { days }，days 为空表示「从未发言」；不匹配返回 null */
export function parseSilentArgs(text) {
  const m = /^(?:查看|清理)(\d*)天?从?未发言(?:的人)?$/.exec(String(text ?? '').trim())
  if (!m) return null
  const days = m[1] ? Math.min(Math.floor(Number(m[1])), 3650) : null
  return { days }
}

/** 这个人不能被自动处置：机器人自己 / 主人 / 配置管理员 / 群管理员群主 */
function isProtectedMember(item, gid) {
  if (item?.IsBot) return true
  const uid = String(item?.UserId ?? '')
  if (!uid) return true
  if (getConfig().admins.includes(uid)) return true
  if (getGroup(gid).admins.includes(uid)) return true
  const role = String(item?.Role ?? '')
  return role === 'admin' || role === 'owner'
}

function formatDate(ms) {
  if (!ms) return '未知'
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 按口径筛出目标成员。
 * days=null 表示「从未发言」：查看时列出所有没说过话的；清理只清统计起点后入群的
 *   （这段历史的发言记录完整，不会误伤部署前就入群的老成员）。
 * days=N 表示「N 天没发言」：最后发言在 N 天前，或没发过言且入群超过 N 天；清理同样只清统计起点后入群的。
 */
function silentTargets(gid, days, { forClean = false } = {}) {
  const cutoff = days ? Date.now() - days * 86400 * 1000 : speakSince()
  const targets = []
  for (const item of silentMembersCache.items) {
    if (isProtectedMember(item, gid)) continue
    const uid = String(item.UserId ?? '')
    if (!uid) continue
    const last = lastSpeakAt(gid, uid)
    const joined = item.JoinedAt ?? 0
    if (days) {
      const silent = last !== undefined ? last < cutoff : joined < cutoff
      if (silent && (!forClean || joined >= speakSince())) targets.push(item)
    } else if (!last) {
      if (!forClean || joined >= speakSince()) targets.push(item)
    }
  }
  return targets
}

let silentMembersCache = { at: 0, items: [] }

function memberLine(item, gid) {
  const name = item.UserName || lookupName(gid, item.UserId) || '未知昵称'
  return `${name}（${String(item.UserId).slice(0, 10)}…）入群 ${formatDate(item.JoinedAt)}`
}

/** 预览文本：前 30 行 + 总数 */
function previewLines(items, gid, title) {
  const lines = [title, '', `共 ${items.length} 人` + (items.length > 30 ? '，以下展示前 30 人' : ''), '']
  items.slice(0, 30).forEach((item, index) => lines.push(`${index + 1}. ${memberLine(item, gid)}`))
  return lines.join('\n')
}

/** #查看未发言的人 / #查看N天未发言的人 */
export async function viewSilent(days) {
  const gid = guildId()
  const res = await members(gid, true)
  if (res.failed) return reply(`拉不到群成员列表：${res.reason}\n这个接口需要成员列表白名单权限（报 11253 就是没批）。`)
  silentMembersCache = { at: Date.now(), items: res.items }
  const targets = silentTargets(gid, days)
  const scope = days ? `${days} 天未发言` : '进群后从未发言'
  if (!targets.length) return reply(`没有${scope}的成员。`)
  const since = formatDate(speakSince())
  const header = `**${scope}：${targets.length} 人**（发言统计自 ${since}，此前发言记录不在统计内）`
  await reply(previewLines(targets, gid, header))
}

/** #清理从未发言的人 / #清理N天未发言的人：只预览，确认后才执行 */
export async function cleanSilent(days) {
  const gid = guildId()
  const res = await members(gid, true)
  if (res.failed) return reply(`拉不到群成员列表：${res.reason}\n这个接口需要成员列表白名单权限（报 11253 就是没批）。`)
  silentMembersCache = { at: Date.now(), items: res.items }
  const targets = silentTargets(gid, days, { forClean: true })
  const scope = days ? `${days} 天未发言` : '从未发言'
  if (!targets.length) return reply(`没有符合清理条件（${scope}）的成员。`)
  pendingCleanup.set(gid, { days, targets: targets.map((item) => String(item.UserId)), at: Date.now() })
  const header = `**准备清理${scope}的成员：${targets.length} 人**（尚未执行）`
  const confirmCmd = days ? `#确认清理${days}天未发言的人` : '#确认清理从未发言的人'
  await reply(`${previewLines(targets, gid, header)}\n\n确认执行请发：${confirmCmd}\n取消请发：#取消清理（5 分钟内有效）`)
}

/** #确认清理…：真正踢人，每批 20 个 */
export async function confirmClean(event = event()) {
  if (!(await requireAdmin())) return
  const gid = guildId()
  const pending = pendingCleanup.get(gid)
  if (!pending || Date.now() - pending.at > CLEANUP_TTL) {
    pendingCleanup.delete(gid)
    return reply('没有待确认的清理任务，或已超时。先发 #清理从未发言的人 生成预览。')
  }
  pendingCleanup.delete(gid)
  flushSpeak()
  const targets = pending.targets.filter((uid) => !lastSpeakAt(gid, uid))
  const spared = pending.targets.length - targets.length
  if (!targets.length) return reply('确认期间所有人都说过话了，本次清理取消。')
  const [member] = useMember()
  let kicked = 0
  let failed = 0
  for (let index = 0; index < targets.length; index += KICK_BATCH) {
    const chunk = targets.slice(index, index + KICK_BATCH)
    try {
      const result = await member.kickMany({ userIds: chunk, blacklist: false })
      if (isOk(result)) {
        kicked += chunk.length
        bumpStats(gid, 'kicked', chunk.length)
      } else {
        failed += chunk.length
        logError('批量清理失败', describe(result))
      }
    } catch (err) {
      failed += chunk.length
      logError('批量清理失败', err)
    }
    if (index + KICK_BATCH < targets.length) await new Promise((resolve) => setTimeout(resolve, 600))
  }
  clearMemberCache(gid)
  const suffix = spared > 0 ? `（${spared} 人在等待期间发了言，已自动豁免）` : ''
  await reply(`清理完成：移出 ${kicked} 人${failed ? `，失败 ${failed} 人` : ''}${suffix}。`)
}

/** #取消清理 */
export async function cancelClean() {
  if (!(await requireAdmin())) return
  const gid = guildId()
  if (!pendingCleanup.has(gid)) return reply('当前没有待确认的清理任务。')
  pendingCleanup.delete(gid)
  await reply('已取消本次清理。')
}

/** 中间件入口：匹配未发言相关命令返回 true（已处理），否则 false 交回路由 */
export async function maybeSilentCommand(event) {
  const stripped = String(event?.MessageText ?? '').trim().replace(/^[#＃/!！]/, '')
  if (!stripped) return false
  try {
    if (/^确认清理/.test(stripped)) {
      await confirmClean(event)
      return true
    }
    if (/^取消清理/.test(stripped)) {
      await cancelClean()
      return true
    }
    const parsed = parseSilentArgs(stripped)
    if (!parsed) return false
    if (!(await requireAdmin())) return true
    if (stripped.startsWith('查看')) await viewSilent(parsed.days)
    else await cleanSilent(parsed.days)
    return true
  } catch (err) {
    logError('未发言命令处理失败', err)
    return false
  }
}
