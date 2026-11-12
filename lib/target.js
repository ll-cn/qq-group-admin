import { members, mentions } from './api.js'
import { getConfig } from './config.js'
import { isOpenId, parseDuration } from './util.js'

/** 目标解析：@ 提及 → openid → #序号 → 昵称 */
export async function resolveTargets(guildId, args) {
  const config = getConfig()
  const targets = []
  const words = []

  for (const item of await mentions()) {
    if (item?.UserId) targets.push({ userId: item.UserId, name: item.UserName || item.UserId.slice(0, 6) })
  }

  let memberList = null
  let listReason = ''
  const loadList = async () => {
    if (memberList) return memberList
    const res = await members(guildId)
    memberList = res.items
    listReason = res.reason
    return memberList
  }

  for (const raw of args) {
    const arg = String(raw ?? '').replace(/^[@＠]/, '').trim()
    if (!arg) continue
    if (isOpenId(arg)) {
      targets.push({ userId: arg, name: arg.slice(0, 6) })
      continue
    }
    if (/^#\d+$/.test(arg)) {
      const list = await loadList()
      if (!list.length) return { error: listUnavailable(listReason) }
      const index = Number(arg.slice(1))
      const hit = list[index - 1]
      if (!hit) return { error: `没有第 ${index} 位成员，可发「#群成员」查看编号` }
      targets.push({ userId: hit.UserId, name: hit.UserName || hit.UserId.slice(0, 6) })
      continue
    }
    words.push(arg)
  }

  if (!targets.length && words.length) {
    const list = await loadList()
    if (!list.length) return { error: listUnavailable(listReason) }
    const key = words.join(' ').trim()
    const exact = list.filter((item) => (item.UserName ?? '') === key)
    const fuzzy = exact.length ? exact : list.filter((item) => (item.UserName ?? '').includes(key))
    if (!fuzzy.length) return { error: `没找到昵称是「${key}」的群成员，可发「#群成员」查看编号` }
    if (fuzzy.length > 1) {
      const names = fuzzy.slice(0, 5).map((item) => item.UserName || item.UserId.slice(0, 6)).join('、')
      return { error: `有 ${fuzzy.length} 个成员匹配「${key}」：${names}，请改用「#序号」或 openid` }
    }
    targets.push({ userId: fuzzy[0].UserId, name: fuzzy[0].UserName || fuzzy[0].UserId.slice(0, 6) })
  }

  if (!targets.length) return { error: '请指定对象：@他、openid、【#序号】或昵称' }
  if (targets.length > 10) return { error: `一次最多处理 10 个成员，这次给了 ${targets.length} 个` }
  return { targets, rest: words }
}

/** 从参数末尾取禁言时长；没写就用默认值 */
export function pickDuration(args) {
  const config = getConfig()
  const rest = [...args]
  if (rest.length) {
    const last = rest[rest.length - 1]
    const parsed = parseDuration(last)
    if (parsed !== null && /[a-z秒分时天日]/i.test(last)) {
      rest.pop()
      return { seconds: clampSeconds(parsed, config), rest }
    }
    if (rest.length > 1 && /^\d+$/.test(last)) {
      rest.pop()
      return { seconds: clampSeconds(Number(last), config), rest }
    }
  }
  return { seconds: config.defaultMuteSeconds, rest }
}

export function clampSeconds(seconds, config) {
  const max = config.maxMuteSeconds
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  return Math.min(value, max)
}

function listUnavailable(reason) {
  const hint = reason && reason.includes('11253')
    ? '群成员列表接口需要白名单权限（错误码 11253），请联系平台运营申请'
    : `群成员列表拉取失败：${reason || '未知原因'}`
  return `${hint}\n可以改用 openid 指定对象，或先把机器人设为群管理员后重试`
}
