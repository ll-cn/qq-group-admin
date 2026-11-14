/**
 * 入群申请通知卡片的生命周期管理：
 * - 记住卡片消息 id，审批后按它撤回
 * - 超过保留时长没人处理就自动撤回（默认 30 秒，配置 joinRequest.autoRecallSeconds）
 */
const cards = new Map()
const TTL = 10 * 60 * 1000
const DEFAULT_HOLD = 30_000

/**
 * rememberCard(requestId, messageId, { holdMs, onExpire })
 * holdMs <= 0 表示不自动撤回；onExpire 拿到 messageId 自己做撤回
 */
export function rememberCard(requestId, messageId, options = {}) {
  const key = String(requestId ?? '')
  const id = String(messageId ?? '')
  if (!key || !id) return
  const now = Date.now()
  for (const [k, v] of cards) {
    if (now - v.at > TTL) {
      if (v.timer) clearTimeout(v.timer)
      cards.delete(k)
    }
  }
  const prev = cards.get(key)
  if (prev?.timer) clearTimeout(prev.timer)

  const holdMs = Number.isFinite(options.holdMs) ? Number(options.holdMs) : DEFAULT_HOLD
  const entry = { id, at: now, timer: null }
  if (holdMs > 0 && typeof options.onExpire === 'function') {
    entry.timer = setTimeout(() => {
      const hit = cards.get(key)
      if (!hit || hit.id !== id) return
      cards.delete(key)
      Promise.resolve()
        .then(() => options.onExpire(id))
        .catch(() => {})
    }, holdMs)
    entry.timer.unref?.()
  }
  cards.set(key, entry)
}

/** 取出并停止自动撤回（审批时调用），返回消息 id */
export function takeCard(requestId) {
  const key = String(requestId ?? '')
  const hit = cards.get(key)
  if (!hit) return ''
  if (hit.timer) clearTimeout(hit.timer)
  cards.delete(key)
  return hit.id
}
