import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.join(__dirname, '..')
export const CONFIG_FILE = path.join(ROOT, 'config', 'config.yaml')
export const DATA_DIR = path.join(ROOT, 'data')
const GROUP_DIR = path.join(DATA_DIR, 'groups')

/** 配置文件缺失/被清空时写回的默认内容 */
const DEFAULT_YAML = `# ===================== 官方群管插件配置 =====================
# 改完保存即时生效（每次指令都会检查文件是否变动，不用重启）。
# 删掉本文件后，下次启动会自动重新生成这份默认配置。

configVersion: 1

# 额外管理员：群成员 openid 列表（机器人主人始终可用）
# 取 openid 的办法：在群里发「#群成员 openid」，列表里带的就是
admins: []

# 默认禁言时长（秒）
defaultMuteSeconds: 600

# 单次最长禁言时长（秒）。官方上限 30 天，不要调大
maxMuteSeconds: 2592000

# 处置后回查一次，确认禁言真的生效（多一次请求，建议开着）
verifyAfterMute: true

# 群成员列表缓存时间（秒）
memberCacheSeconds: 600

# 群成员列表最多翻几页（每页 30 人）。白名单机器人才能用，否则会报 11253
memberMaxPages: 4

# 自动群管：每个群可用「#群管开关」单独开关，这里只是各群的初始默认值
auto:
  enabled: false
  floodSeconds: 10
  floodCount: 8
  floodMuteSeconds: 600
  bannedMuteSeconds: 600
  words: []

# 入群申请：机器人是群管理员才能收到官方推送
joinRequest:
  # 有人申请加群时在群里发通知
  notify: true
  # 通知带「通过 / 拒绝」按钮
  buttons: true
  # ============ 通知文案（怎么填看这里）============
  # 一行一项，可以增删、调顺序、改措辞。
  # 唯一要记住的语法：{变量名} 会被替换成实际内容。
  #
  # 可用变量：
  #   {name}     申请人昵称
  #   {verify}   验证消息
  #   {qa}       问题与答案（最多 3 组，会展开成多行）
  #   {source}   来源：主动申请 / 被邀请（附邀请人）
  #   {risk}     风险提示
  #   {bot}      机器人账号提示
  #
  # 规则：
  #   1. 一行里用到的变量全为空时，这一行不显示
  #      （所以没填验证消息的人，不会留一个空的「验证消息：」）
  #   2. 空字符串行会保留成空行，用来分段
  #
  # 例子 A：只想看昵称和验证消息
  #   template:
  #     - "有人申请加群"
  #     - "申请人：{name}"
  #     - "验证：{verify}"
  #
  # 例子 B：只想看验证消息和问答
  #   template:
  #     - "有人申请加群"
  #     - "验证：{verify}"
  #     - "{qa}"
  #
  # 注意：以 * 开头的行必须用引号包起来，
  #      否则 YAML 会把它当成别名，整份配置解析失败。
  template:
    - "**有新成员申请加群**"
    - ""
    - "昵称：{name}"
    - "验证消息：{verify}"
    - "{qa}"
    - "来源：{source}"
    - "风险：{risk}"
    - "{bot}"

# 入群欢迎（默认关闭；{user} 会替换成「@新成员」）
welcome:
  enabled: false
  text: "欢迎 {user} 加入本群，先看看群公告哦～"
`

/** 进程级默认配置（与 DEFAULT_YAML 保持同结构） */
const DEFAULTS = {
  configVersion: 1,
  admins: [],
  defaultMuteSeconds: 600,
  maxMuteSeconds: 2592000,
  verifyAfterMute: true,
  memberCacheSeconds: 600,
  memberMaxPages: 4,
  auto: {
    enabled: false,
    floodSeconds: 10,
    floodCount: 8,
    floodMuteSeconds: 600,
    bannedMuteSeconds: 600,
    words: []
  },
  joinRequest: {
    notify: true,
    buttons: true,
    template: [
      '**有新成员申请加群**',
      '',
      '昵称：{name}',
      '验证消息：{verify}',
      '{qa}',
      '来源：{source}',
      '风险：{risk}',
      '{bot}'
    ]
  },
  welcome: {
    enabled: false,
    text: '欢迎 {user} 加入本群，先看看群公告哦～'
  }
}

let yamlLib
try {
  yamlLib = (await import('yaml')).default
} catch {
  yamlLib = null
}

function merge(base, patch) {
  if (!patch || typeof patch !== 'object') return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    const prev = out[key]
    if (prev && typeof prev === 'object' && !Array.isArray(prev) && typeof value === 'object' && !Array.isArray(value)) out[key] = merge(prev, value)
    else out[key] = value
  }
  return out
}

function positive(value, def) {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : def
}

/** 把读到的原始配置夹到合法范围 */
function normalize(raw) {
  const auto = raw?.auto ?? {}
  const joinRequest = raw?.joinRequest ?? {}
  const base = merge(DEFAULTS, raw)
  base.configVersion = positive(base.configVersion, 1)
  base.admins = Array.isArray(base.admins) ? base.admins.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()) : []
  base.maxMuteSeconds = Math.max(60, Math.min(positive(base.maxMuteSeconds, 2592000), 2592000))
  base.defaultMuteSeconds = Math.min(positive(base.defaultMuteSeconds, 600), base.maxMuteSeconds)
  base.verifyAfterMute = base.verifyAfterMute !== false
  base.memberCacheSeconds = positive(base.memberCacheSeconds, 600)
  base.memberMaxPages = Math.max(1, Math.min(positive(base.memberMaxPages, 4), 10))
  base.auto = {
    enabled: !!auto.enabled,
    floodSeconds: Math.max(1, positive(auto.floodSeconds, 10)),
    floodCount: Math.max(2, positive(auto.floodCount, 8)),
    floodMuteSeconds: Math.min(positive(auto.floodMuteSeconds, 600), base.maxMuteSeconds),
    bannedMuteSeconds: Math.min(positive(auto.bannedMuteSeconds, 600), base.maxMuteSeconds),
    words: Array.isArray(auto.words) ? auto.words.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim()) : []
  }
  let template = DEFAULTS.joinRequest.template
  if (Array.isArray(joinRequest.template)) {
    const list = joinRequest.template.filter((item) => typeof item === 'string')
    if (list.length) template = list
  } else if (typeof joinRequest.template === 'string') {
    const list = joinRequest.template.split(/\r?\n/)
    if (list.length) template = list
  }
  base.joinRequest = {
    notify: joinRequest.notify !== false,
    buttons: joinRequest.buttons !== false,
    template
  }
  base.welcome = {
    enabled: !!base.welcome?.enabled,
    text: typeof base.welcome?.text === 'string' && base.welcome.text.trim() ? base.welcome.text : DEFAULTS.welcome.text
  }
  return base
}

function ensureFile() {
  try {
    if (fs.existsSync(CONFIG_FILE) && fs.statSync(CONFIG_FILE).size > 0) return
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, DEFAULT_YAML, 'utf8')
  } catch {}
}

/** 给旧配置补上 template 段（带注释）用的文本 */
const TEMPLATE_BLOCK = `  # ============ 通知文案（怎么填看这里）============
  # 一行一项，可以增删、调顺序、改措辞。
  # 唯一要记住的语法：{变量名} 会被替换成实际内容。
  #
  # 可用变量：
  #   {name}     申请人昵称
  #   {verify}   验证消息
  #   {qa}       问题与答案（最多 3 组，会展开成多行）
  #   {source}   来源：主动申请 / 被邀请（附邀请人）
  #   {risk}     风险提示
  #   {bot}      机器人账号提示
  #
  # 规则：一行里用到的变量全为空时，这一行不显示；空行会保留。
  # 注意：以 * 开头的行必须用引号包起来，否则 YAML 解析失败。
  template:
    - "**有新成员申请加群**"
    - ""
    - "昵称：{name}"
    - "验证消息：{verify}"
    - "{qa}"
    - "来源：{source}"
    - "风险：{risk}"
    - "{bot}"`

const JOIN_SECTION = `# 入群申请：机器人是群管理员才能收到官方推送
joinRequest:
  # 有人申请加群时在群里发通知
  notify: true
  # 通知带「通过 / 拒绝」按钮
  buttons: true
${TEMPLATE_BLOCK}`

let templateEnsured = false

/** 老版本配置里没有 template，就把带注释的那一段补进文件，方便直接照着改 */
function ensureTemplate() {
  if (templateEnsured) return
  templateEnsured = true
  let text = ''
  try {
    text = fs.readFileSync(CONFIG_FILE, 'utf8')
  } catch {
    return
  }
  if (!text.trim() || /^\s+template:/m.test(text)) return
  try {
    const lines = text.split('\n')
    const start = lines.findIndex((line) => /^joinRequest:\s*$/.test(line))
    if (start === -1) {
      fs.writeFileSync(CONFIG_FILE, `${text.replace(/\s*$/, '')}\n\n${JOIN_SECTION}\n`, 'utf8')
      return
    }
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i].trim() && !/^\s/.test(lines[i])) {
        end = i
        break
      }
    }
    lines.splice(end, 0, ...TEMPLATE_BLOCK.split('\n'))
    fs.writeFileSync(CONFIG_FILE, lines.join('\n'), 'utf8')
  } catch {}
}

let cached = null
let cachedMtime = 0

/** 读取进程级配置。文件改动后自动重载，不用重启 */
export function getConfig() {
  ensureFile()
  ensureTemplate()
  let mtime = 0
  try {
    mtime = fs.statSync(CONFIG_FILE).mtimeMs
  } catch {}
  if (cached && mtime === cachedMtime) return cached
  let raw = null
  try {
    raw = yamlLib ? yamlLib.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : null
  } catch {
    raw = null
  }
  cached = normalize(raw ?? {})
  cachedMtime = mtime
  return cached
}

function groupFile(guildId) {
  return path.join(GROUP_DIR, `${String(guildId).replace(/[^\w-]/g, '')}.json`)
}

/** 群级配置：没存过就用进程默认值 */
export function getGroup(guildId) {
  const base = getConfig()
  const fallback = {
    auto: { ...base.auto, words: [...base.auto.words] },
    joinRequest: { ...base.joinRequest },
    welcome: { ...base.welcome },
    admins: [],
    stats: { muted: 0, kicked: 0, recalled: 0, approved: 0, rejected: 0 }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(groupFile(guildId), 'utf8'))
    return {
      auto: { ...fallback.auto, ...(saved.auto ?? {}), words: Array.isArray(saved.auto?.words) ? saved.auto.words : fallback.auto.words },
      joinRequest: { ...fallback.joinRequest, ...(saved.joinRequest ?? {}) },
      welcome: { ...fallback.welcome, ...(saved.welcome ?? {}) },
      admins: Array.isArray(saved.admins) ? saved.admins : [],
      stats: { ...fallback.stats, ...(saved.stats ?? {}) }
    }
  } catch {
    return fallback
  }
}

/** 写群级配置：只覆盖传入的字段 */
export function saveGroup(guildId, patch) {
  const next = { ...getGroup(guildId), ...patch }
  try {
    fs.mkdirSync(GROUP_DIR, { recursive: true })
    fs.writeFileSync(groupFile(guildId), JSON.stringify(next, null, 2), 'utf8')
  } catch {}
  return next
}

/** 累加统计数字 */
export function bumpStats(guildId, key, delta = 1) {
  const group = getGroup(guildId)
  const stats = { ...group.stats }
  stats[key] = (Number(stats[key]) || 0) + delta
  saveGroup(guildId, { stats })
}
