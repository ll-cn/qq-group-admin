/**
 * 入群申请相关消息的生命周期管理：
 * - 申请通知卡片：审批后按它撤回，超时没人处理也撤回
 * - #入群申请 列表：超时撤回；处理完一条后立刻撤回（序号会变，留着容易点错人）
 * 只存内存：撤回窗口本身只有 2 分钟，进程重启后旧消息也撤不回。
 */
const store = new Map()
const TTL = 10 * 60 * 1000
const DEFAULT_HOLD = 30_000

function remember(key, messageId, options = {}) {
  const k = String(key ?? '')
  const id = String(messageId ?? '')
  if (!k || !id) return
  const now = Date.now()
  for (const [name, item] of store) {
    if (now - item.at > TTL) {
      if (item.timer) clearTimeout(item.timer)
      store.delete(name)
    }
  }
  const prev = store.get(k)
  if (prev?.timer) clearTimeout(prev.timer)

  const holdMs = Number.isFinite(options.holdMs) ? Number(options.holdMs) : DEFAULT_HOLD
  const entry = { id, at: now, timer: null }
  if (holdMs > 0 && typeof options.onExpire === 'function') {
    entry.timer = setTimeout(() => {
      const hit = store.get(k)
      if (!hit || hit.id !== id) return
      store.delete(k)
      Promise.resolve()
        .then(() => options.onExpire(id))
        .catch(() => {})
    }, holdMs)
    entry.timer.unref?.()
  }
  store.set(k, entry)
}

function take(key) {
  const k = String(key ?? '')
  const hit = store.get(k)
  if (!hit) return ''
  if (hit.timer) clearTimeout(hit.timer)
  store.delete(k)
  return hit.id
}

/** 申请通知：key = 申请 id */
export const rememberCard = (requestId, messageId, options) => remember(`req:${requestId}`, messageId, options)
export const takeCard = (requestId) => take(`req:${requestId}`)

/** #入群申请 列表：key = 群，一个群只保留最近一条 */
export const rememberPanel = (guildId, messageId, options) => remember(`panel:${guildId}`, messageId, options)
export const takePanel = (guildId) => take(`panel:${guildId}`)
