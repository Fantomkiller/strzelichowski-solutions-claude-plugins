import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const SETTINGS = '/home/u/.claude/settings.json'

// Stands in for the host: a home, a settings file, the transcript's notices.
const host = (on: On, settings: string | undefined) => {
  const files = new Map<string, string>()
  if (settings !== undefined) files.set(SETTINGS, settings)
  const notices: string[] = []
  const commands: string[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    notices.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 's1' }))
  on('command.run', (_$, e) => ({ text: `no hook for ${e.command}` }))
  return { files, notices, commands }
}

const start = ($: Engine) =>
  $.session.start({ surface: 'terminal', cwd: '/work', source: 'startup' } as never)

const runSetup = ($: Engine) =>
  $.command.run({ command: 'context-guard-setup', args: '', origin: { kind: 'composer' } } as never)

test('setup sets the capped model\'s window so it compacts at about 95k, keeping the rest', async ($, on) => {
  const { files } = host(on, JSON.stringify({ model: 'opus', modelSettings: { 'claude-haiku-5-5': { effortLevel: 'high', autoCompactWindow: 100000 } } }))
  const r = await runSetup($)
  expect(r.text).toMatch(/claude-haiku-5-5\.autoCompactWindow: 100000 -> 128000/)
  expect(r.text).toMatch(/compact at about 95k/)
  expect(JSON.parse(files.get(SETTINGS) ?? '{}')).toEqual({
    model: 'opus',
    modelSettings: { 'claude-haiku-5-5': { effortLevel: 'high', autoCompactWindow: 128000 } },
  })
  expect(files.get(`${SETTINGS}.bak-context-guard`)).toMatch(/100000/)
})

test('setup on a settings file that is already right changes nothing', async ($, on) => {
  const { files } = host(on, JSON.stringify({ modelSettings: { 'claude-haiku-5-5': { autoCompactWindow: 128000 } } }))
  const r = await runSetup($)
  expect(r.text).toMatch(/already set/)
  expect(files.has(`${SETTINGS}.bak-context-guard`)).toBe(false)
})

test('setup leaves a settings file that does not parse alone', async ($, on) => {
  const { files } = host(on, '{ broken')
  const r = await runSetup($)
  expect(r.text).toMatch(/does not parse/)
  expect(files.get(SETTINGS)).toBe('{ broken')
})

test('setup follows the compaction point option', { options: { subagent_compact_tokens: 90_000 } }, async ($, on) => {
  const { files } = host(on, undefined)
  await runSetup($)
  expect(JSON.parse(files.get(SETTINGS) ?? '{}')).toEqual({ modelSettings: { 'claude-haiku-5-5': { autoCompactWindow: 123000 } } })
})

test('a session start registers /context-guard-setup and says once when it is needed', async ($, on) => {
  const { notices, commands } = host(on, JSON.stringify({ modelSettings: { 'claude-haiku-5-5': { autoCompactWindow: 100000 } } }))
  await start($)
  expect(commands).toContain('context-guard-setup')
  expect(notices.filter(n => /run \/context-guard-setup/.test(n)).length).toBe(1)
})

test('no notice when the window is already right', async ($, on) => {
  const { notices } = host(on, JSON.stringify({ modelSettings: { 'claude-haiku-5-5': { autoCompactWindow: 128000 } } }))
  await start($)
  expect(notices.filter(n => /context-guard-setup/.test(n))).toEqual([])
})
