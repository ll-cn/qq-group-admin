import { PLUGIN_NAME, VERSION } from './version.js'
import { logError } from './util.js'

let jsxp = null
let jsxpTried = false
let renderFails = 0

async function getJsxp() {
  if (jsxpTried) return jsxp
  jsxpTried = true
  try {
    jsxp = await import('jsxp')
  } catch (err) {
    logError('加载 jsxp 失败，发言榜退回文本', err)
    jsxp = null
  }
  return jsxp
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

function shortName(text, max = 12) {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 头像里的首字：取第一个字符，不加省略号 */
function initial(text) {
  const value = String(text ?? '').trim()
  return value ? Array.from(value)[0] : '?'
}

const PALETTE = [
  'linear-gradient(135deg,#7c6cf0,#5b7cf7)',
  'linear-gradient(135deg,#f7a13c,#f4813c)',
  'linear-gradient(135deg,#48c6b8,#31a9c9)',
  'linear-gradient(135deg,#ef7fa8,#e0618d)',
  'linear-gradient(135deg,#8f9bf0,#6f7ee0)',
  'linear-gradient(135deg,#6ec6e8,#4aa6d8)',
  'linear-gradient(135deg,#b48ce8,#9b6ede)',
  'linear-gradient(135deg,#7ecf9b,#51b77c)',
  'linear-gradient(135deg,#f0b06a,#e08f4d)',
  'linear-gradient(135deg,#9aa7bd,#7b8aa3)'
]

/**
 * data: { groupName, days, since, total, rows: [{ rank, name, count, percent, last }] }
 */
export function buildRankHtml(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : []
  const top = rows.slice(0, 3)
  const rest = rows.slice(3)
  const total = Number(data?.total ?? 0)

  const podiumOrder = [1, 0, 2]
  const podium = podiumOrder
    .map((index) => {
      const item = top[index]
      if (!item) return '<div class="pod-slot"></div>'
      const medal = item.rank === 1 ? 'gold' : item.rank === 2 ? 'silver' : 'bronze'
      const crown = item.rank === 1 ? '<div class="crown">👑</div>' : ''
      return `
        <div class="pod ${medal}">
          ${crown}
          <div class="pod-avatar" style="background:${PALETTE[(item.rank - 1) % PALETTE.length]}"><span>${escapeHtml(initial(item.name))}</span>${item.avatar ? `<img src="${escapeHtml(item.avatar)}" alt="" onerror="this.remove()" />` : ''}</div>
          <div class="pod-badge">${item.rank}</div>
          <div class="pod-name">${escapeHtml(shortName(item.name))}</div>
          <div class="pod-count">${item.count}</div>
          <div class="pod-sub">${item.percent} · ${escapeHtml(item.last)}</div>
        </div>`
    })
    .join('')

  const list = rest
    .map((item) => `
      <div class="row">
        <div class="rank">${item.rank}</div>
        <div class="avatar" style="background:${PALETTE[(item.rank - 1) % PALETTE.length]}"><span>${escapeHtml(initial(item.name))}</span>${item.avatar ? `<img src="${escapeHtml(item.avatar)}" alt="" onerror="this.remove()" />` : ''}</div>
        <div class="who">
          <div class="who-name">${escapeHtml(item.name)}</div>
          <div class="who-sub">最后发言 ${escapeHtml(item.last)}</div>
        </div>
        <div class="right">
          <div class="count">${item.count}</div>
          <div class="percent">${item.percent}</div>
        </div>
        <div class="bar"><i style="width:${Math.max(4, Math.min(100, Number(item.barPercent ?? 0)))}%"></i></div>
      </div>`)
    .join('')

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 720px;
    padding: 34px 30px 24px;
    font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
    color: #1e2233;
    background: linear-gradient(170deg, #ffffff 0%, #f7f8ff 42%, #eef1fd 78%, #e8ecfb 100%);
  }
  .glow { position: absolute; width: 420px; height: 420px; border-radius: 50%; filter: blur(90px); opacity: .38; }
  .glow.a { top: -140px; left: -80px; background: #c9c4ff; }
  .glow.b { top: -60px; right: -120px; background: #bcd7ff; }
  .head { position: relative; display: flex; align-items: flex-end; justify-content: space-between; }
  .title { font-size: 34px; font-weight: 800; letter-spacing: .5px;
    background: linear-gradient(96deg,#6a5cf5,#3f83f7 70%,#2fa6d8);
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  .sub { margin-top: 8px; display: flex; gap: 8px; align-items: center; }
  .chip { background: rgba(106,92,245,.1); color: #5b5bd6; border-radius: 6px; padding: 3px 8px; font-size: 12px; }
  .chip.plain { background: rgba(31,35,51,.06); color: #6b7280; }
  .total { text-align: right; }
  .total b { font-size: 40px; font-weight: 800; color: #2b2f44; letter-spacing: -1px; }
  .total span { display: block; margin-top: 2px; font-size: 12px; color: #9aa1b4; }
  .podium { position: relative; display: flex; justify-content: center; align-items: flex-end; gap: 26px; margin: 30px 0 22px; }
  .pod { width: 168px; text-align: center; position: relative; }
  .pod-slot { width: 168px; }
  .pod-avatar {
    position: relative; overflow: hidden;
    width: 74px; height: 74px; border-radius: 50%; margin: 0 auto;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 26px;
    border: 3px solid #fff; box-shadow: 0 6px 18px rgba(72,86,150,.18);
  }
  .pod.gold .pod-avatar { width: 88px; height: 88px; font-size: 30px; box-shadow: 0 0 0 3px rgba(247,161,60,.55), 0 10px 24px rgba(247,161,60,.32); }
  .pod.silver .pod-avatar { box-shadow: 0 0 0 3px rgba(150,162,186,.5), 0 8px 20px rgba(120,132,158,.22); }
  .pod.bronze .pod-avatar { box-shadow: 0 0 0 3px rgba(201,123,74,.5), 0 8px 20px rgba(201,123,74,.22); }
  .crown { position: absolute; top: -22px; left: 50%; transform: translateX(-50%); font-size: 22px; }
  .pod-badge {
    position: absolute; right: 34px; bottom: 62px;
    width: 22px; height: 22px; border-radius: 50%; background: #2b2f44; color: #fff;
    font-size: 12px; display: flex; align-items: center; justify-content: center; border: 2px solid #fff;
  }
  .pod.gold .pod-badge { background: #f7a13c; right: 26px; bottom: 74px; }
  .pod-name { margin-top: 10px; font-size: 13px; font-weight: 600; color: #2b2f44; }
  .pod-count { margin-top: 4px; font-size: 24px; font-weight: 800; color: #6a5cf5; }
  .pod.gold .pod-count { color: #ef8a2b; }
  .pod-sub { margin-top: 2px; font-size: 11px; color: #9aa1b4; }
  .board { position: relative; background: rgba(255,255,255,.82); border-radius: 18px; padding: 8px 16px 10px;
    box-shadow: 0 10px 30px rgba(74,88,150,.1); border: 1px solid rgba(255,255,255,.9); }
  .row { position: relative; display: flex; align-items: center; gap: 12px; padding: 13px 4px 15px; border-bottom: 1px solid rgba(31,35,51,.05); }
  .row:last-child { border-bottom: none; }
  .rank { width: 22px; text-align: center; font-size: 14px; font-weight: 700; color: #a2a8ba; }
  .avatar { position: relative; overflow: hidden; width: 38px; height: 38px; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; flex: 0 0 38px; }
  .avatar img, .pod-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .who { flex: 1; min-width: 0; }
  .who-name { font-size: 14px; font-weight: 600; color: #23283c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .who-sub { margin-top: 3px; font-size: 11px; color: #9aa1b4; }
  .right { text-align: right; min-width: 64px; }
  .count { font-size: 15px; font-weight: 700; color: #2b2f44; }
  .percent { margin-top: 2px; font-size: 11px; color: #9aa1b4; }
  .bar { position: absolute; left: 76px; right: 8px; bottom: 7px; height: 4px; border-radius: 3px; background: rgba(31,35,51,.06); overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(96deg,#7c6cf0,#4d8df5); }
  .foot { margin-top: 18px; text-align: center; font-size: 11px; color: #a6acbd; }
</style></head>
<body>
  <div class="glow a"></div><div class="glow b"></div>
  <div class="head">
    <div>
      <div class="title">发言排行榜</div>
      <div class="sub">
        <span class="chip">群聊 · ${escapeHtml(data?.groupName || '本群')}</span>
        <span class="chip plain">最近 ${escapeHtml(String(data?.days ?? 7))} 天</span>
      </div>
    </div>
    <div class="total"><b>${total}</b><span>总发言次数</span></div>
  </div>
  <div class="podium">${podium}</div>
  <div class="board">${list || '<div class="row"><div class="who"><div class="who-name">没有更多记录了</div></div></div>'}</div>
  <div class="foot">统计自 ${escapeHtml(data?.since || '')} · 只统计机器人收到过消息的成员 · ${escapeHtml(PLUGIN_NAME)} v${escapeHtml(VERSION)}</div>
</body></html>`
}

/** 渲染发言榜图，失败/超时返回 null */
export async function renderRankImage(data) {
  if (renderFails >= 3) return null
  const lib = await getJsxp()
  if (!lib?.renderHtmlToBuffer) return null
  let timer = null
  try {
    const task = lib.renderHtmlToBuffer(buildRankHtml(data), {
      playwright: {
        context: { viewport: { width: 720, height: 900 }, deviceScaleFactor: 2 },
        waitForFonts: true
      }
    })
    task.catch(() => {})
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 15000)
    })
    const img = await Promise.race([task, timeout])
    if (!img || !img.length) {
      renderFails += 1
      logError('发言榜渲染未出结果，已退回文本', `fail=${renderFails}`)
      return null
    }
    renderFails = 0
    return img
  } catch (err) {
    renderFails += 1
    logError('发言榜渲染失败，已退回文本', err)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
