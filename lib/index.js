import { Router, defineChildren, defineMiddleware } from 'alemonjs'
import { getConfig } from './config.js'
import { getQQClient } from './api.js'
import { guard, leaveNotice, onJoinRequest, welcome } from './auto.js'
import * as commands from './commands.js'
import { rememberName } from './nick.js'
import { rememberSpeak } from './speak.js'
import { maybeSilentCommand } from './commands.js'
import { expose } from './expose.js'
import { isStaleEvent, logError, logInfo } from './util.js'
import { koaRouter } from './web.js'
import { PLUGIN_NAME, VERSION } from './version.js'

const MESSAGE_EVENTS = ['message.create', 'private.message.create']
const ALL_EVENTS = [...MESSAGE_EVENTS, 'interaction.create', 'private.interaction.create', 'notice.create', 'member.add', 'member.remove']

const router = Router.create({ events: MESSAGE_EVENTS })

const app = router.group({
  routeText: {
    prefixes: ['#', '＃', '/', '!', '！'],
    stripPrefix: true,
    allowBare: true
  },
  duplicateKey: 'ignore'
})

/** 注册一条指令：permission = 'admin'（默认，四级判定）或 'all'（任何人可用） */
function reg(path, description, fn, permission = 'admin') {
  app.use({ path, description }, () => Promise.resolve({
    default: async () => {
      logInfo(`执行指令 ${path}`)
      try {
        if (!(await commands.checkPermission(permission))) return
        await fn()
      } catch (err) {
        logError(`指令 ${path} 执行失败`, err)
      }
    }
  }))
}

reg('群管帮助', '群管指令说明', commands.help, 'all')
reg('群管', '群管指令说明', commands.help, 'all')
reg('群管面板', '按钮面板', commands.panel)
reg('禁言', '禁言群成员', () => commands.punish(false))
reg('解禁', '解除成员禁言', () => commands.punish(true))
reg('禁言状态', '查看群禁言状态', commands.muteStatus)
reg('全员禁言', '开启全员禁言', () => commands.allMute(true))
reg('解除全员禁言', '关闭全员禁言', () => commands.allMute(false))
reg('踢人', '移出群成员', () => commands.memberAction('kick'))
reg('拉黑', '移出并拉黑成员', () => commands.memberAction('ban'))
reg('解除拉黑', '解除成员拉黑', () => commands.memberAction('unban'))
reg('黑名单', '查看拉黑名单', commands.banList)
reg('群成员', '查看群成员列表', commands.memberList)
reg('群信息', '查看群信息', commands.info)
reg('撤回', '撤回机器人上一条消息', commands.recallSelf)
reg('入群申请', '入群申请列表', commands.joinList)
reg('通过', '通过入群申请', () => commands.joinDecide(true))
reg('拒绝', '拒绝入群申请', () => commands.joinDecide(false))
reg('自动审批', '入群自动审批开关', commands.joinPolicy)
reg('群管开关', '自动群管开关', commands.toggleAuto)
reg('违禁词', '违禁词管理', commands.badWords)
reg('刷屏设置', '刷屏阈值设置', commands.floodSetting)
reg('刷新成员', '清空成员缓存', commands.refreshMembers)

const noop = () => undefined

/**
 * 中间件跑在 response 链之前，不受 apps 加载顺序影响。
 * 开了入群欢迎/退群通知就直接吃掉事件（不调 next），云崽自带的进群退群通知收不到；
 * 没开就放行，交给云崽那边处理。
 */
async function onEvent(event, next) {
  try {
    const name = String(event?.name ?? '')
    if (name === 'message.create' || name === 'private.message.create') {
      const stale = isStaleEvent(event)
      if (name === 'message.create') {
        rememberName(event.GuildId, event.UserId, event.UserName)
        if (!stale) {
          rememberSpeak(event.GuildId, event.UserId)
          getQQClient(event).catch(() => null)
        }
      }
      if (stale) return next()
      if (await maybeSilentCommand(event)) return next()
      const handled = await router.dispatch(event)
      if (!handled?.matched) await guard(event, noop)
    } else if (name.includes('interaction')) {
      await commands.onButton(event, noop)
    } else if (name === 'notice.create') {
      await onJoinRequest(event, noop)
    } else if (name === 'member.add') {
      if (isStaleEvent(event)) return next()
      logInfo(`收到成员事件 member.add（群=${event.GuildId}）`)
      rememberName(event.GuildId, event.UserId, event.UserName)
      if (await welcome(event)) return
    } else if (name === 'member.remove') {
      if (isStaleEvent(event)) return next()
      logInfo(`收到成员事件 member.remove（群=${event.GuildId}）`)
      if (await leaveNotice(event)) return
    }
  } catch (err) {
    logError('事件处理失败', err)
  }
  return next()
}

const middlewareRouter = defineMiddleware([
  { selects: ALL_EVENTS, regular: /[\s\S]*/, handler: () => Promise.resolve(onEvent) }
])

export default defineChildren({
  register() {
    return { middlewareRouter, koaRouter, expose }
  },
  onReady() {
    const config = getConfig()
    logInfo(`${PLUGIN_NAME} v${VERSION} 已加载｜自动群管默认${config.auto.enabled ? '开' : '关'}｜管理员 ${config.admins.length} 人`)
  }
})

export { VERSION }
