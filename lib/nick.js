import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

const FILE = path.join(DATA_DIR, 'nickname.json')
const MAX = 3000
const SAVE_DELAY = 2000

let store = null
let timer = null

function load() {
  if (store) return store
  store = new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string' && value) store.set(key, { name: value, avatar: '' })
      else if (value && typeof value === 'object' && (value.name || value.avatar)) {
        store.set(key, { name: String(value.name ?? ''), avatar: String(value.avatar ?? '') })
      }
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

/** 记下成员的 openid、昵称与头像（openid 按群独立，所以带上群标识） */
export function rememberName(guildId, userId, name, avatar) {
  const gid = String(guildId ?? '')
  const uid = String(userId ?? '')
  const nick = String(name ?? '').trim()
  const face = String(avatar ?? '').trim()
  if (!gid || !uid || (!nick && !face)) return
  const map = load()
  const key = keyOf(gid, uid)
  const prev = map.get(key)
  if (prev && (!nick || prev.name === nick) && (!face || prev.avatar === face)) return
  if (!prev && map.size >= MAX) map.delete(map.keys().next().value)
  map.set(key, { name: nick || prev?.name || '', avatar: face || prev?.avatar || '' })
  scheduleSave()
}

/** 查昵称，查不到返回空串 */
export function lookupName(guildId, userId) {
  const gid = String(guildId ?? '')
  const uid = String(userId ?? '')
  if (!gid || !uid) return ''
  return load().get(keyOf(gid, uid))?.name ?? ''
}

/** 查头像 URL，查不到返回空串 */
export function lookupAvatar(guildId, userId) {
  const gid = String(guildId ?? '')
  const uid = String(userId ?? '')
  if (!gid || !uid) return ''
  return load().get(keyOf(gid, uid))?.avatar ?? ''
}

/** 已记录的昵称条数（网页面板用） */
export function countNames() {
  return load().size
}
