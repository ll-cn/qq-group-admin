import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

/** data/speak.json：{ since, guilds: { [群id]: { [openid]: [最后发言ms, 次数] } } } */
const FILE = path.join(DATA_DIR, 'speak.json')
const MAX_PER_GUILD = 3000
const SAVE_DELAY = 3000

let store = null
let timer = null

function load() {
  if (store) return store
  store = { since: Date.now(), guilds: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (Number.isFinite(raw?.since)) store.since = raw.since
    if (raw?.guilds && typeof raw.guilds === 'object') store.guilds = raw.guilds
  } catch {}
  return store
}

function flush() {
  timer = null
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(store), 'utf8')
  } catch {}
}

function scheduleSave() {
  if (timer) return
  timer = setTimeout(flush, SAVE_DELAY)
  timer.unref?.()
}

function guildMap(guildId) {
  const data = load()
  const gid = String(guildId ?? '')
  data.guilds[gid] ??= {}
  return data.guilds[gid]
}

/** 记一次发言：更新最后发言时间与次数 */
export function rememberSpeak(guildId, userId) {
  const gid = String(guildId ?? '')
  const uid = String(userId ?? '')
  if (!gid || !uid) return
  const map = guildMap(gid)
  if (!map[uid]) {
    if (Object.keys(map).length >= MAX_PER_GUILD) {
      const oldest = Object.entries(map).sort((a, b) => a[1][0] - b[1][0])[0]
      if (oldest) delete map[oldest[0]]
    }
    map[uid] = [Date.now(), 0]
  }
  map[uid][0] = Date.now()
  map[uid][1] += 1
  scheduleSave()
}

/** 最后发言时间（ms），从未发言返回 undefined */
export function lastSpeakAt(guildId, userId) {
  const entry = load().guilds[String(guildId ?? '')]?.[String(userId ?? '')]
  return entry?.[0]
}

/** 发言榜：最近 days 天内发过言的人，按累计次数排序（days<=0 不限窗口） */
export function speakRank(guildId, days = 7, limit = 10) {
  const map = load().guilds[String(guildId ?? '')] ?? {}
  const cutoff = days > 0 ? Date.now() - days * 86400 * 1000 : 0
  return Object.entries(map)
    .filter(([, entry]) => !cutoff || Number(entry?.[0] ?? 0) >= cutoff)
    .map(([userId, entry]) => ({ userId, last: Number(entry?.[0] ?? 0), count: Number(entry?.[1] ?? 0) }))
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, limit)
}

/** 窗口内的全部发言记录（不截断），用于算占比和总数 */
export function speakWindow(guildId, days = 7) {
  const map = load().guilds[String(guildId ?? '')] ?? {}
  const cutoff = days > 0 ? Date.now() - days * 86400 * 1000 : 0
  return Object.entries(map)
    .filter(([, entry]) => !cutoff || Number(entry?.[0] ?? 0) >= cutoff)
    .map(([userId, entry]) => ({ userId, last: Number(entry?.[0] ?? 0), count: Number(entry?.[1] ?? 0) }))
    .sort((a, b) => b.count - a.count || b.last - a.last)
}

/** 潜水榜：有发言记录但最近 days 天没说话的人，按最后一次发言由远到近 */
export function speakDormant(guildId, days = 7, limit = 10) {
  const map = load().guilds[String(guildId ?? '')] ?? {}
  const cutoff = Date.now() - Math.max(1, days) * 86400 * 1000
  return Object.entries(map)
    .map(([userId, entry]) => ({ userId, last: Number(entry?.[0] ?? 0), count: Number(entry?.[1] ?? 0) }))
    .filter((item) => item.last > 0 && item.last < cutoff)
    .sort((a, b) => a.last - b.last)
    .slice(0, limit)
}

/** 统计起点（这个时间之后说过话的才会被记录） */
export function speakSince() {
  return load().since
}

/** 立即落盘（清理等关键操作前调用） */
export function flushSpeak() {
  load()
  flush()
}
