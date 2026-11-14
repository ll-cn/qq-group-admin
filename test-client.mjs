import fs from 'node:fs'

// 统计起点设为 60 天前，模拟已部署一段时间的机器人
const DAY = 86400 * 1000
fs.rmSync(new URL('./data/', import.meta.url), { recursive: true, force: true })
fs.mkdirSync(new URL('./data/', import.meta.url), { recursive: true })
fs.writeFileSync(new URL('./data/speak.json', import.meta.url), JSON.stringify({
  since: Date.now() - 60 * DAY,
  guilds: {}
}), 'utf8')

const { __state } = await import('alemonjs')
const { __qq } = await import('@alemonjs/qq-bot')
const { saveConfig } = await import('./lib/config.js')

saveConfig({ admins: [] })

let ok = true
const check = (name, cond, extra = '') => {
  ok = ok && cond
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`)
}

// --- A：显式事件成功，且进程内缓存（不重复调 useClient）---
{
  const api = await import('./lib/api.js?bust=A')
  const event = { name: 'message.create', GuildId: 'G1', UserId: 'U1' }
  const client = await api.getQQClient(event)
  check('显式事件拿到客户端', !!client)
  const calls1 = __qq.useClientCalls
  await api.getQQClient(event)
  check('客户端进程内缓存（不再调 useClient）', __qq.useClientCalls === calls1)
}

// --- B：失败路径 + 60 秒退避 ---
{
  const api = await import('./lib/api.js?bust=B')
  __qq.clientThrows = true
  const client = await api.getQQClient()
  check('useClient 抛错时返回 null（不崩溃）', client === null)
  const calls1 = __qq.useClientCalls
  const again = await api.getQQClient()
  check('60 秒退避内不重试', again === null && __qq.useClientCalls === calls1)
  __qq.clientThrows = false
}

// --- C：单成员信息兜底（显式事件）---
{
  const api = await import('./lib/api.js?bust=C')
  const commands = await import('./lib/commands.js')
  __qq.clientThrows = false
  __state.memberForbidden = true
  __state.memberInfoRole = 'admin'
  __state.event = { name: 'interaction.create', GuildId: 'G1', UserId: 'LULU', MessageText: 'join_ok:J1:U_APPLY', value: { author: { member_role: '' } } }
  await commands.onButton(__state.event, async () => 'next')
  check('列表 11253 + 单成员接口 admin → 审批放行', __state.decideCalls.length === 1)
}

// --- D：确认清理用事件上下文里的客户端 ---
{
  const api = await import('./lib/api.js?bust=D')
  const commands = await import('./lib/commands.js')
  const { saveConfig: sc } = await import('./lib/config.js')
  sc({ admins: ['ADMIN'] })
  __state.memberForbidden = false
  __state.memberList = [{ UserId: 'U_A', UserName: '甲', Role: 'member', JoinedAt: Date.now() - 90 * 86400 * 1000, IsBot: false }]
  __state.event = { name: 'message.create', GuildId: 'G2', UserId: 'ADMIN', MessageText: '#清理从未发言的人', value: {} }
  await commands.maybeSilentCommand(__state.event)
  check('清理预览生成', __state.sent.join('').includes('确认执行请发'))
  __state.sent = []
  __state.event = { name: 'message.create', GuildId: 'G2', UserId: 'ADMIN', MessageText: '#确认清理从未发言的人', value: {} }
  await commands.maybeSilentCommand(__state.event)
  check('确认清理经显式事件批量踢人', __qq.calls.length === 1 && __qq.calls[0][1] === 'G2')
}

console.log(ok ? '\n全部通过' : '\n有失败')
process.exit(ok ? 0 : 1)
