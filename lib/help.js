import { reply, sendImage } from './api.js'
import { logError } from './util.js'
import { PLUGIN_NAME, VERSION } from './version.js'

/** 帮助内容：文本版和图片版共用这份数据 */
export const HELP_SECTIONS = [
  {
    title: '禁言',
    items: [
      ['#禁言 @他 10m', '禁言；时长可写 10m / 1h / 2d / 600s'],
      ['#解禁 @他', '解除禁言'],
      ['#禁言状态', '被禁言的人 + 全员禁言状态'],
      ['#全员禁言', '整群禁言；#解除全员禁言 关闭']
    ]
  },
  {
    title: '成员管理',
    items: [
      ['#查看未发言的人', '列出入群后一直没发过言的人'],
      ['#查看30天未发言的人', '入群超过 30 天且没发过言的人（天数可改）'],
      ['#清理从未发言的人', '预览清理名单（尚未执行）'],
      ['#清理30天未发言的人', '按 N 天口径预览清理名单'],
      ['#确认清理从未发言的人', '确认执行清理（5 分钟内有效）'],
      ['#取消清理', '取消待确认的清理任务'],
      ['#我的openid', '查自己的 openid'],
      ['#认领管理员', '还没有管理员时，第一位自举'],
      ['#授权管理员 @某人', '把某人加进管理员（主人/群主）'],
      ['#撤销管理员 @某人', '撤销某人的管理员（主人/群主）'],
      ['#管理员列表', '查看额外管理员']
    ]
  },
  {
    title: '成员',
    items: [
      ['#踢人 @他', '移出本群'],
      ['#拉黑 @他', '移出并拉黑'],
      ['#解除拉黑 @他', '解除拉黑'],
      ['#黑名单', '拉黑名单'],
      ['#群成员', '成员编号；加 openid 看完整 openid'],
      ['#刷新成员', '清空成员缓存，下次重新拉取']
    ]
  },
  {
    title: '入群申请',
    items: [
      ['#入群申请', '待审批列表（机器人需是群管理员）'],
      ['#通过 2', '通过第 2 条；#拒绝 2 理由'],
      ['#自动审批', '查看/开关自动审批策略']
    ]
  },
  {
    title: '群设置',
    items: [
      ['#群信息', '群名、人数、我的身份、群管状态'],
      ['#群管面板', '按钮面板，点一下直接执行'],
      ['#群管开关 开/关', '自动群管总开关'],
      ['#违禁词', '查看；#违禁词 添加 词；#违禁词 删除 词'],
      ['#刷屏设置 10 8 600', '10 秒内 8 条 → 禁言 600 秒'],
      ['#撤回', '撤回我上一条消息']
    ]
  }
]

const TIPS = [
  '指定对象可以写 openid 或「#序号」（序号见 #群成员）。',
  '@ 只有在机器人能收到提及信息时才生效，拿不到时请用上面两种方式。'
]

const TAGLINE = '禁言 · 踢人 · 入群审批 · 自动群管'

/** 纯文本帮助（图片渲染失败时的兜底） */
export const HELP_TEXT = [
  `【${PLUGIN_NAME}】指令一览`,
  '',
  ...HELP_SECTIONS.flatMap((section) => [
    `· ${section.title}`,
    ...section.items.map(([cmd, desc]) => `  ${cmd} ｜ ${desc}`),
    ''
  ]),
  ...TIPS
].join('\n')

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

/** 帮助图 HTML */
export function buildHelpHtml() {
  const sections = HELP_SECTIONS.map((section) => `
    <section>
      <div class="sec">${escapeHtml(section.title)}</div>
      ${section.items.map(([cmd, desc]) => `<div class="row"><span class="cmd"><code>${escapeHtml(cmd)}</code></span><span class="desc">${escapeHtml(desc)}</span></div>`).join('')}
    </section>
  `).join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 828px;
    padding: 22px;
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif;
    background: linear-gradient(155deg, #eef3fd 0%, #e6ecf9 55%, #eaf0fb 100%);
    -webkit-font-smoothing: antialiased;
  }
  .card {
    position: relative;
    overflow: hidden;
    background: #ffffff;
    border-radius: 22px;
    padding: 24px 28px 18px;
    box-shadow: 0 14px 36px rgba(38, 58, 100, 0.11);
  }
  .card::after {
    content: '';
    position: absolute;
    top: -120px;
    right: -90px;
    width: 260px;
    height: 260px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(96, 138, 255, 0.16), rgba(96, 138, 255, 0));
  }
  .head {
    position: relative;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding-bottom: 15px;
    border-bottom: 1px solid #edf0f7;
  }
  .title { font-size: 28px; font-weight: 700; color: #1b2436; letter-spacing: 1.5px; }
  .tagline { margin-top: 7px; font-size: 12.5px; color: #8a93a8; letter-spacing: 0.5px; }
  .ver {
    margin-top: 4px;
    padding: 3px 10px;
    border-radius: 20px;
    background: #f1f5fe;
    border: 1px solid #e2eafb;
    color: #6b7ea8;
    font-size: 11.5px;
    letter-spacing: 0.5px;
  }
  section { margin-top: 15px; }
  .sec {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 5px;
    font-size: 14.5px;
    font-weight: 600;
    color: #3f6ae0;
    letter-spacing: 0.3px;
  }
  .sec::before {
    content: '';
    width: 3.5px;
    height: 14px;
    border-radius: 3px;
    background: linear-gradient(180deg, #7ba1ff, #3f6ae0);
  }
  .row {
    display: grid;
    grid-template-columns: 208px 1fr;
    align-items: center;
    gap: 4px;
    padding: 5.5px 0 5.5px 11px;
    border-bottom: 1px dashed #f1f3f9;
  }
  .row:last-child { border-bottom: none; }
  .cmd { display: flex; }
  code {
    padding: 3px 8px;
    border-radius: 7px;
    border: 1px solid #e3e9f8;
    background: #f4f7fd;
    color: #22304a;
    font-family: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.4;
    white-space: nowrap;
  }
  .desc { color: #6f798c; font-size: 12.8px; line-height: 1.5; }
  .foot {
    position: relative;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid #edf0f7;
    color: #97a0b4;
    font-size: 12px;
    line-height: 1.7;
  }
</style></head>
<body>
  <div class="card">
    <div class="head">
      <div>
        <div class="title">${escapeHtml(PLUGIN_NAME)}</div>
        <div class="tagline">${escapeHtml(TAGLINE)}</div>
      </div>
      <div class="ver">v${escapeHtml(VERSION)}</div>
    </div>
    ${sections}
    <div class="foot">${TIPS.map(escapeHtml).join('<br>')}</div>
  </div>
</body></html>`
}

let jsxp = null
let jsxpTried = false

/** 动态加载 jsxp（插件目录往上能找到 alemon 的 node_modules） */
async function getJsxp() {
  if (jsxpTried) return jsxp
  jsxpTried = true
  try {
    jsxp = await import('jsxp')
  } catch (err) {
    logError('加载 jsxp 失败，帮助将退回文本', err)
    jsxp = null
  }
  return jsxp
}

let renderFails = 0

/** 渲染帮助图，失败或超时返回 null（连续失败就不再多试，避免每条帮助都卡十几秒） */
export async function renderHelpImage() {
  if (renderFails >= 3) return null
  const lib = await getJsxp()
  if (!lib?.renderHtmlToBuffer) return null
  let timer = null
  try {
    const task = lib.renderHtmlToBuffer(buildHelpHtml(), {
      playwright: {
        context: { viewport: { width: 872, height: 600 }, deviceScaleFactor: 2 },
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
      logError('帮助图渲染未出结果，已退回文本', `fail=${renderFails}`)
      return null
    }
    renderFails = 0
    return img
  } catch (err) {
    renderFails += 1
    logError('帮助图渲染失败', err)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 发帮助：默认图片，失败退回文本；mode='text' 时直接发文本（AI/无浏览器环境） */
export async function sendHelp(mode = 'image') {
  if (mode === 'text') {
    await reply(HELP_TEXT)
    return
  }
  const img = await renderHelpImage()
  if (img) {
    await sendImage(img)
    return
  }
  await reply(HELP_TEXT)
}
