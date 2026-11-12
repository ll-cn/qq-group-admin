import { muteOne, panelMessage, reply, sendMarkdown } from './api.js'
import { bumpStats, getGroup } from './config.js'
import { formatDuration, logError } from './util.js'

const floodMap = new Map()
const coolMap = new Map()
const COOL_MS = 60_000

function keyOf(guildId, userId) {
  return `${guildId}:${userId}`
}

/** 交还给下一个 app：alemon 里不调用 next 就等于把事件吃掉 */
function pass(next) {
  return typeof next === 'function' ? next() : undefined
}

/** 定期清掉过期记录，避免长跑内存涨 */
function sweep(now) {
  if (floodMap.size < 800) return
  for (const [key, list] of floodMap) {
    if (!list.length || now - list[list.length - 1] > 120_000) floodMap.delete(key)
  }
  for (const [key, at] of coolMap) {
    if (now - at > COOL_MS) coolMap.delete(key)
  }
}

/** 命中违禁词则返回那个词 */
function hitWord(text, words) {
  if (!text || !words?.length) return ''
  const lower = String(text).toLowerCase()
  return words.find((word) => word && lower.includes(String(word).toLowerCase())) ?? ''
}

/** 自动群管：每条消息过一遍，命中就处置，最后放行给下一个 app */
export async function guard(event, next) {
  try {
    if (event?.name !== 'message.create' && event?.name !== 'private.message.create') return pass(next)
    const guildId = event?.GuildId ?? ''
    const userId = event?.UserId ?? ''
    if (!guildId || !userId) return pass(next)
    if (event?.IsBot) return pass(next)

    const group = getGroup(guildId)
    if (!group.auto.enabled) return pass(next)

    const role = event?.value?.author?.member_role ?? ''
    if (event?.IsMaster || role === 'admin' || role === 'owner') return pass(next)

    const now = Date.now()
    sweep(now)
    const key = keyOf(guildId, userId)
    if (now - (coolMap.get(key) ?? 0) < COOL_MS) return pass(next)

    const text = String(event?.MessageText ?? '')
    if (/^[#＃/!！]/.test(text.trim())) return pass(next)

    const word = hitWord(text, group.auto.words)
    if (word) {
      await punish(event, group.auto.bannedMuteSeconds, `发了违禁词「${word}」`)
      return pass(next)
    }

    if (!text.trim()) return pass(next)
    const window = group.auto.floodSeconds * 1000
    const list = (floodMap.get(key) ?? []).filter((at) => now - at <= window)
    list.push(now)
    floodMap.set(key, list)
    if (list.length > group.auto.floodCount) {
      floodMap.delete(key)
      await punish(event, group.auto.floodMuteSeconds, `${group.auto.floodSeconds} 秒内发了 ${list.length} 条消息`)
    }
    return pass(next)
  } catch (err) {
    logError('自动群管处理失败', err)
    return pass(next)
  }
}

async function punish(event, seconds, reason) {
  const guildId = event.GuildId
  const userId = event.UserId
  if (seconds <= 0) {
    await reply(`注意：${reason}，再刷就禁言了。`)
    return
  }
  const res = await muteOne(guildId, userId, seconds)
  if (!res.ok) return
  coolMap.set(keyOf(guildId, userId), Date.now())
  bumpStats(guildId, 'muted')
  await reply(`因为${reason}，已被禁言 ${formatDuration(seconds)}。`)
}

export { hitWord }

/** 按模板渲染通知：某一行用到的变量全为空，就整行不显示 */
export function renderTemplate(template, vars) {
  const list = Array.isArray(template)
    ? template
    : typeof template === 'string'
      ? template.split(/\r?\n/)
      : []
  const lines = []
  for (const item of list) {
    const line = String(item ?? '')
    if (!line.trim()) {
      lines.push('')
      continue
    }
    const keys = [...line.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
    if (keys.length && keys.every((key) => !vars[key])) continue
    lines.push(line.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? ''))
  }
  return lines.join('\n').trim()
}

/** 入群申请通知：机器人是群管理员时官方才会推这个事件 */
export async function onJoinRequest(event, next) {
  try {
    const raw = event?.value ?? {}
    const guildId = event?.GuildId ?? raw.group_openid ?? ''
    if (!guildId || !raw.join_request_id) return pass(next)
    const group = getGroup(guildId)
    if (!group.joinRequest?.notify) return pass(next)

    const name = raw.username || String(raw.member_openid ?? '').slice(0, 8) || '未知'
    const openid = String(raw.member_openid ?? '')
    const verify = raw.verify_info?.verify_message
    const questions = Array.isArray(raw.verify_info?.review_qa_list) ? raw.verify_info.review_qa_list : []
    const inviter = raw.invited_by ? String(raw.invited_by).slice(0, 8) : ''

    const vars = {
      name,
      openid,
      openid8: openid.slice(0, 8),
      verify: verify ?? '',
      qa: questions
        .slice(0, 3)
        .map((item) => `问题：${item.question ?? ''}\n答案：${item.answer ?? ''}`)
        .join('\n'),
      source: raw.apply_source === 'invited' ? `被邀请${inviter ? `（邀请人 ${inviter}…）` : ''}` : '主动申请',
      risk: raw.risk_tips ?? '',
      bot: raw.bot ? '注意：这是机器人账号' : ''
    }

    const text = renderTemplate(group.joinRequest?.template, vars)

    if (group.joinRequest.buttons) {
      await panelMessage(text, [[
        { title: '通过', data: `join_ok:${raw.join_request_id}:${raw.member_openid}` },
        { title: '拒绝', data: `join_no:${raw.join_request_id}:${raw.member_openid}` }
      ]])
    } else {
      await reply(`${text}\n处理：#通过 序号 ｜ #拒绝 序号（先发 #入群申请）`)
    }
    return pass(next)
  } catch (err) {
    logError('入群申请通知失败', err)
    return pass(next)
  }
}

/** 入群欢迎（默认关闭） */
export async function welcome(event, next) {
  try {
    if (event?.name !== 'member.add') return pass(next)
    const guildId = event?.GuildId ?? ''
    if (!guildId) return pass(next)
    const group = getGroup(guildId)
    if (!group.welcome?.enabled) return pass(next)
    const name = event?.UserName || '新成员'
    const text = String(group.welcome.text ?? '').replace(/\{user\}/g, name)
    const openid = event?.UserId ?? ''
    if (group.welcome.mention !== false && openid) {
      await sendMarkdown(text, openid)
    } else {
      await reply(text)
    }
    return pass(next)
  } catch (err) {
    logError('入群欢迎发送失败', err)
    return pass(next)
  }
}

/** 退群通知（默认关闭） */
export async function leaveNotice(event, next) {
  try {
    if (event?.name !== 'member.remove') return pass(next)
    const guildId = event?.GuildId ?? ''
    if (!guildId) return pass(next)
    const group = getGroup(guildId)
    if (!group.leave?.enabled) return pass(next)
    const name = event?.UserName || '有成员'
    await reply(String(group.leave.text ?? '').replace(/\{user\}/g, name))
    return pass(next)
  } catch (err) {
    logError('退群通知发送失败', err)
    return pass(next)
  }
}
