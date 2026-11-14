import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

/** data/denied.json：[{ openid, guildId, at }]，等主人在面板里一键授权 */
const FILE = path.join(DATA_DIR, 'denied.json')
const MAX = 20

let store = null

function load() {
  if (store) return store
  store = []
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (Array.isArray(raw)) store = raw.filter((item) => item && item.openid)
  } catch {}
  return store
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8')
  } catch {}
}

/** 记下一个权限不足的 openid（去重，保留最近 20 个） */
export function recordDenied(openid, guildId) {
  const uid = String(openid ?? '').trim()
  if (!uid) return
  const list = load()
  const hit = list.find((item) => item.openid === uid)
  if (hit) {
    hit.at = Date.now()
    hit.guildId = String(guildId ?? hit.guildId ?? '')
  } else {
    list.unshift({ openid: uid, guildId: String(guildId ?? ''), at: Date.now() })
    if (list.length > MAX) list.length = MAX
  }
  save()
}

/** 待授权列表（按时间倒序） */
export function listDenied() {
  return [...load()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}

/** 授权后从待办里移除 */
export function removeDenied(openid) {
  const uid = String(openid ?? '').trim()
  const list = load()
  const index = list.findIndex((item) => item.openid === uid)
  if (index === -1) return false
  list.splice(index, 1)
  save()
  return true
}
