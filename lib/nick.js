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
    for (const [key, name] of Object.entries(raw)) {
      if (typeof name === 'string' && name) store.set(key, name)
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

/** 记下成员的 openid 与昵称（openid 按群独立，所以带上群标识） */
export function rememberName(guildId, userId, name) {
  const gid = String(guildId ?? '')
  const uid = String(userId ?? '')
  const nick = String(name ?? '').trim()
  if (!gid || !uid || !nick) return
  const map = load()
  const key = keyOf(gid, uid)
  if (map.get(key) === nick) return
  if (!map.has(key) && map.size >= MAX) map.delete(map.keys().next().value)
  map.set(key, nick)
  scheduleSave()
}

/** 查昵称，查不到返回空串 */
export function lookupName(guildId, userId) {
  const gid = String(guildId ?? '')
  const uid = String(userId ?? '')
  if (!gid || !uid) return ''
  return load().get(keyOf(gid, uid)) ?? ''
}
