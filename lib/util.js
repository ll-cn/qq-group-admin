import { logger } from 'alemonjs'

/** 秒/分/时/天 单位换算表 */
const UNIT = {
  s: 1, 秒: 1, 秒钟: 1,
  m: 60, 分: 60, 分钟: 60, 分种: 60,
  h: 3600, 时: 3600, 小时: 3600, 点: 3600,
  d: 86400, 天: 86400, 日: 86400
}

/**
 * 禁言时长解析：支持 600 / 600s / 10m / 1h30m / 2d / 10分钟 / 1天 / 0
 * 纯数字按秒；0 表示解除禁言。解析失败返回 null。
 */
export function parseDuration(input) {
  if (input === null || input === undefined) return null
  const text = String(input).trim().toLowerCase()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  let total = 0
  let used = false
  const re = /(\d+(?:\.\d+)?)\s*(s|m|h|d|秒钟|秒|分钟|分种|分|小时|时|点|天|日)/g
  let match
  while ((match = re.exec(text))) {
    total += Number(match[1]) * (UNIT[match[2]] ?? 0)
    used = true
  }
  return used ? Math.round(total) : null
}

/** 秒 → 「1 天 2 小时」这种可读文本 */
export function formatDuration(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0))
  if (sec === 0) return '0 秒'
  const parts = []
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (d) parts.push(`${d} 天`)
  if (h) parts.push(`${h} 小时`)
  if (m) parts.push(`${m} 分钟`)
  if (s) parts.push(`${s} 秒`)
  return parts.join(' ')
}

/** openid 形态：大写十六进制串（群成员 openid / 群 openid 都是这个样式） */
export function isOpenId(text) {
  return typeof text === 'string' && /^[0-9A-Za-z_-]{16,64}$/.test(text) && !/[^\x00-\x7F]/.test(text)
}

/** 结果是否成功（code 2000） */
export function isOk(result) {
  return !!result && result.code === 2000
}

/** 把 hook 返回的 Result 变成一句人话 */
export function describe(result) {
  if (!result) return '接口没有返回内容'
  const message = typeof result.message === 'string' ? result.message : ''
  const data = result.data
  const detail = typeof data === 'string' ? data : data && typeof data === 'object' ? data.message ?? data.msg ?? '' : ''
  if (message && detail && !message.includes(detail)) return `${message}：${detail}`
  return message || detail || `错误码 ${result.code ?? '未知'}`
}

/** 数组按 pageSize 切片 */
export function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export function logError(scene, err) {
  try {
    logger.error(`[官方群管] ${scene}: ${err?.stack ?? err?.message ?? err}`)
  } catch {}
}

export function logInfo(scene) {
  try {
    logger.info(`[官方群管] ${scene}`)
  } catch {}
}

/** 从事件里提取消息时间（官方 payload 的 timestamp，秒/毫秒都兼容），取不到返回 null */
export function eventTime(event) {
  const raw = event?.value ?? {}
  const t = raw.timestamp ?? raw.time ?? raw.msg_time
  if (t === undefined || t === null || t === '') return null
  const n = Number(t)
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n
  const parsed = Date.parse(String(t))
  return Number.isNaN(parsed) ? null : parsed
}

/** 是否为陈旧事件（QQ 会重放历史消息，超过 maxAgeMs 的只记录不响应） */
export function isStaleEvent(event, maxAgeMs = 5 * 60 * 1000) {
  const t = eventTime(event)
  return t !== null && Date.now() - t > maxAgeMs
}
