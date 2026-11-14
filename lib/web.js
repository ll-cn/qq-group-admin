import { DATA_DIR, getConfig, saveConfig } from './config.js'
import { countNames } from './nick.js'
import { listDenied, removeDenied } from './denied.js'
import { logError } from './util.js'
import { VERSION, PLUGIN_NAME } from './version.js'

/**
 * 网页面板的后端路由。
 * 框架会把 /apps/qq-group-admin/api/xxx 透传给这里的中间件（ctx.path 已剥掉前缀），
 * 所以路由都按 /api/xxx 写。
 */

const NUMBER_FIELDS = [
  ['defaultMuteSeconds', 60],
  ['maxMuteSeconds', 60],
  ['memberCacheSeconds', 0],
  ['memberMaxPages', 1],
  ['auto.floodSeconds', 1],
  ['auto.floodCount', 2],
  ['auto.floodMuteSeconds', 0],
  ['auto.bannedMuteSeconds', 0]
]

const BOOL_FIELDS = [
  'verifyAfterMute',
  'auto.enabled',
  'joinRequest.notify',
  'joinRequest.buttons',
  'welcome.enabled',
  'welcome.mention',
  'leave.enabled'
]

const STRING_FIELDS = ['welcome.text', 'leave.text', 'web.token']

const LIST_FIELDS = ['admins', 'auto.words', 'joinRequest.template']

function pick(obj, path) {
  let cur = obj
  for (const key of path.split('.')) {
    cur = cur?.[key]
    if (cur === undefined) return undefined
  }
  return cur
}

function setByPath(obj, path, value) {
  const keys = path.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i += 1) {
    cur[keys[i]] ??= {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
}

/** 把请求体整理成合法补丁；未知字段一律丢弃 */
function toPatch(body) {
  const patch = {}
  for (const [field, min] of NUMBER_FIELDS) {
    const value = pick(body, field)
    if (value === undefined || value === null || value === '') continue
    const num = Number(value)
    if (!Number.isFinite(num) || num < min) continue
    setByPath(patch, field, Math.floor(num))
  }
  for (const field of BOOL_FIELDS) {
    const value = pick(body, field)
    if (value === undefined) continue
    setByPath(patch, field, value === true || value === 'true' || value === 1 || value === '1')
  }
  for (const field of STRING_FIELDS) {
    const value = pick(body, field)
    if (value === undefined || value === null) continue
    setByPath(patch, field, String(value))
  }
  for (const field of LIST_FIELDS) {
    const value = pick(body, field)
    if (value === undefined || value === null) continue
    let list = typeof value === 'string' ? value.split(/\r?\n/) : value
    if (!Array.isArray(list)) continue
    list = list.map((item) => String(item ?? '').replace(/\r/g, ''))
    if (field === 'joinRequest.template') list = list.filter((line, index) => line.trim() || index < list.length - 1)
    setByPath(patch, field, list)
  }
  return patch
}

async function readBody(ctx) {
  const raw = ctx.request?.body
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'object') return raw
    try {
      return JSON.parse(String(raw))
    } catch {
      throw new Error('请求体不是合法 JSON')
    }
  }
  const chunks = []
  for await (const chunk of ctx.req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function tokenOk(ctx) {
  const token = getConfig().web.token
  if (!token) return true
  const header = String(ctx.get?.('x-panel-token') ?? '')
  const given = header || String(ctx.query?.token ?? '')
  if (given.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i += 1) diff |= token.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}

async function sendStatus(ctx) {
  let groups = 0
  try {
    groups = (await import('node:fs')).readdirSync(DATA_DIR + '/groups').filter((name) => name.endsWith('.json')).length
  } catch {}
  ctx.status = 200
  ctx.body = {
    code: 200,
    message: 'ok',
    data: {
      plugin: PLUGIN_NAME,
      version: VERSION,
      groups,
      nicknames: countNames(),
      configEnabled: getConfig().web.token ? '口令已开启' : '口令未开启'
    }
  }
}

const ROUTES = [
  {
    method: 'GET',
    path: '/api/status',
    async handler(ctx) {
      await sendStatus(ctx)
    }
  },
  {
    method: 'GET',
    path: '/api/config',
    async handler(ctx) {
      ctx.status = 200
      ctx.body = { code: 200, message: 'ok', data: { config: getConfig() } }
    }
  },
  {
    method: 'POST',
    path: '/api/config',
    async handler(ctx) {
      const patch = toPatch(await readBody(ctx))
      const saved = saveConfig(patch)
      ctx.status = 200
      ctx.body = { code: 200, message: '已保存，改动即时生效', data: { config: saved } }
    }
  },
  {
    method: 'GET',
    path: '/api/denied',
    async handler(ctx) {
      ctx.status = 200
      ctx.body = { code: 200, message: 'ok', data: { items: listDenied() } }
    }
  },
  {
    method: 'POST',
    path: '/api/denied/approve',
    async handler(ctx) {
      const body = await readBody(ctx)
      const openid = String(body?.openid ?? '').trim()
      if (!openid) {
        ctx.status = 400
        ctx.body = { code: 400, message: '缺少 openid' }
        return
      }
      const admins = getConfig().admins.slice()
      if (!admins.includes(openid)) admins.push(openid)
      saveConfig({ admins })
      removeDenied(openid)
      ctx.status = 200
      ctx.body = { code: 200, message: `已把 ${openid.slice(0, 10)}… 加入管理员`, data: { admins } }
    }
  }
]

/** 兼容 koa-router 的最小实现：routes()/allowedMethods() 各返回一个中间件 */
export const koaRouter = {
  routes() {
    return async (ctx, next) => {
      const route = ROUTES.find((item) => item.method === ctx.method && item.path === ctx.path)
      if (!route) return next()
      try {
        if (!tokenOk(ctx)) {
          ctx.status = 401
          ctx.body = { code: 401, message: '面板口令不对。在 URL 后面加 ?token=xxx，或配置里清空 web.token' }
          return
        }
        await route.handler(ctx)
        return
      } catch (err) {
        logError('面板接口处理失败', err)
        ctx.status = 500
        ctx.body = { code: 500, message: String(err?.message ?? err) }
        return
      }
    }
  },
  allowedMethods() {
    return async (ctx, next) => next()
  }
}
