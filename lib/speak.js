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
  store = { since: Date.now(), guilds: {}, joins: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (Number.isFinite(raw?.since)) store.since = raw.since
    if (raw?.guilds && typeof raw.guilds === 'object') store.guilds = raw.guilds
    if (raw?.joins && typeof raw.joins === 'object') store.joins = raw.joins
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
export function rememberSpeak(guildId, userId) {  const gid = String(guildId ?? '')
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

/** 统计起点（这个时间之后说过话的才会被记录） */
export function speakSince() {
  return load().since
}

/** 立即落盘（清理等关键操作前调用） */
export function flushSpeak() {
  load()
  flush()
}

/** 记一次入群（只覆盖插件运行期间看到的入群事件） */
export function rememberJoin(guildId, userId, at = Date.now()) {
  const gid = String(guildId ?? '')
  const uid = String(userId ?? '')
  if (!gid || !uid) return
  const data = load()
  data.joins[gid] ??= {}
  const map = data.joins[gid]
  if (!map[uid] && Object.keys(map).length >= MAX_PER_GUILD) {
    const oldest = Object.entries(map).sort((a, b) => a[1] - b[1])[0]
    if (oldest) delete map[oldest[0]]
  }
  map[uid] = Number(at) || Date.now()
  scheduleSave()
}

/** 退群时清掉入群记录 */
export function forgetJoin(guildId, userId) {
  const gid = String(guildId ?? '')
  const uid = String(userId ?? '')
  const map = load().joins[gid]
  if (!map || !map[uid]) return
  delete map[uid]
  scheduleSave()
}

/** 插件见过的入群记录：[{ userId, joinedAt }] */
export function joinEntries(guildId) {
  const map = load().joins[String(guildId ?? '')]
  if (!map) return []
  return Object.entries(map).map(([userId, joinedAt]) => ({ userId, joinedAt }))
}
