import { useEvent, useRoute } from 'alemonjs'
import {
  banOne, blacklist, botRole, clearMemberCache, decideJoin, groupInfo, joinPolicies, joinRequests,
  kickOne, members, muteOne, muteState, panelMessage, recall, reply, setAllMute, setJoinPolicy, unbanOne
} from './api.js'
import { bumpStats, getConfig, getGroup, saveGroup } from './config.js'
import { rememberName } from './nick.js'
import { sendHelp } from './help.js'
import { clampSeconds, pickDuration, resolveTargets } from './target.js'
import { describe, formatDuration } from './util.js'

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

/** 无权限时回一句并返回 false */
async function requireAdmin() {
  if (canManage()) return true
  await reply('这个指令只有群管理员能用。\n如果我的身份识别错了，把 openid 加到 config/config.yaml 的 admins 里即可。')
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

/** 从按钮 data 审批：join_ok:<requestId>:<openid> */
async function decideFromButton(key, approve) {
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

/** 按钮回调：button_data 就是这里的分发键 */
const BUTTON_MAP = {
  禁言状态: () => muteStatus(),
  群成员: () => memberList(),
  全员禁言: () => allMute(true),
  解除全员禁言: () => allMute(false),
  群信息: () => info(),
  群管帮助: () => help()
}

export async function onButton(event, next) {
  if (!String(event?.name ?? '').includes('interaction')) return typeof next === 'function' ? next() : undefined
  const key = String(event?.MessageText ?? '')
    .trim()
    .replace(/^notAutoConfirmation:/, '')
    .replace(/^[#＃/!！]/, '')
  if (key.startsWith('join_ok:')) return decideFromButton(key, true)
  if (key.startsWith('join_no:')) return decideFromButton(key, false)
  const handler = BUTTON_MAP[key]
  if (!handler) return typeof next === 'function' ? next() : undefined
  await handler()
  return true
}
