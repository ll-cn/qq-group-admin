import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

/**
 * 群内角色缓存：{ "群id:openid": "admin" | "owner" | "member" }
 * 来源只有消息事件的 author.member_role —— 官方交互事件（点按钮）不带身份，
 * 所以谁在群里说过话，我们就把他的角色记下来，之后点按钮时按这个判。
 */
const FILE = path.join(DATA_DIR, 'roles.json')
const MAX = 2000
const SAVE_DELAY = 2000

let store = null
let timer = null

function load() {
  if (store) return store
  store = new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string' && value) store.set(key, value)
    }
  } catch {}
  return store
}

function flush() {
  timer = null
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(store)), 'utf8')
  } catch {}
}

function scheduleSave() {
  if (timer) return
  timer = setTimeout(flush, SAVE_DELAY)
  timer.unref?.()
}

function keyOf(guildId, userId) {
  return `${guildId}:${userId}`
}

/** 记下角色（member / admin / owner），无效值忽略 */
export function rememberRole(guildId, userId, role) {
  const gid = String(guildId ?? '')
  const uid = String(userId ?? '')
  const value = String(role ?? '').trim()
  if (!gid || !uid || !['member', 'admin', 'owner'].includes(value)) return
  const map = load()
  const key = keyOf(gid, uid)
  if (map.get(key) === value) return
  if (!map.has(key) && map.size >= MAX) map.delete(map.keys().next().value)
  map.set(key, value)
  scheduleSave()
}

/** 查角色，没有返回空串 */
export function lookupRole(guildId, userId) {
  const gid = String(guildId ?? '')
  const uid = String(userId ?? '')
  if (!gid || !uid) return ''
  return load().get(keyOf(gid, uid)) ?? ''
}

/** 立即落盘 */
export function flushRoles() {
  load()
  flush()
}
