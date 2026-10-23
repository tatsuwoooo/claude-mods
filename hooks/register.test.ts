import { expect, test } from 'claude-code/testing'

const PANE = { component: 'Pane', requestId: 'token-usage', props: {} } as const
const LISTED = ['clear', 'compact', 'context', 'cost', 'code-review'].map(name => ({
  name,
  description: '',
  source: 'builtin' as const,
}))

test('the pane shows the context fill and the cost', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: LISTED }))
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.session.measure({
      context: { window: 200000 },
      rateLimits: [],
      changed: ['context'],
    })
    const waiting = await $.ui.mount({ plugin: 'claude-mods', surface, ...PANE })
    expect(await waiting.find({ type: 'Text', text: /計測待ち/ })).toBeDefined()
    await waiting.unmount()

    await $.session.measure({
      context: { tokens: 50000, window: 200000, percent: 25 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12.5 },
        { kind: 'seven_day', percentUsed: 40 },
      ],
      cost: { usd: 1.5 },
      changed: ['context', 'cost'],
    })
    const ui = await $.ui.mount({ plugin: 'claude-mods', surface, ...PANE })
    expect(
      await ui.find({ type: 'Text', text: /50,000 \/ 200,000/ }),
    ).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /25%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /12\.5% 使用/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /40% 使用/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /残り 60%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the band button opens the pane', async ($, on) => {
  const opened: string[] = []
  on('ui.panes', () => ({ value: [] }))
  on('ui.open',(_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    opened.length = 0
    const ui = await $.ui.mount({
      plugin: 'claude-mods',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false },
    })
    await ui.press({ key: 'open-pane' })
    expect(opened).toEqual(['token-usage'])
    await ui.unmount()
  }
})

test('the band button shoots the clicked window', async ($, on) => {
  const ran: string[][] = []
  on('ui.panes', () => ({ value: [] }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])

    return {
      exitCode: 0,
      stdout: 'OK 800x600',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    ran.length = 0
    const ui = await $.ui.mount({
      plugin: 'claude-mods',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false },
    })
    await ui.press({ key: 'shoot' })
    expect(ran.length).toBe(1)
    expect(ran[0]!.some(arg => arg.endsWith('scripts/window-shot.ps1'))).toBe(
      true,
    )
    await ui.unmount()
  }
})

test('a command button runs its command, /clear only once confirmed', async ($, on) => {
  const ran: string[] = []
  const asked: string[] = []
  on('command.list', () => ({ value: LISTED }))
  on('command.run', (_, e) => {
    ran.push(e.command)
    asked.push(`/${e.command} ${e.args}`.trim())

    return { text: '' }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    ran.length = 0
    const ui = await $.ui.mount({ plugin: 'claude-mods', surface, ...PANE })
    await ui.press({ key: 'compact' })
    expect(ran).toEqual(['compact'])

    await ui.press({ key: 'clear' })
    expect(ran).toEqual(['compact'])
    await ui.press({ key: 'cancel' })
    expect(ran).toEqual(['compact'])

    await ui.press({ key: 'clear' })
    await ui.press({ key: 'confirm' })
    expect(ran).toEqual(['compact', 'clear'])

    // No /review listed here: the button falls back to /code-review.
    asked.length = 0
    await ui.press({ key: 'review' })
    expect(asked).toEqual([])
    await ui.press({ key: 'confirm' })
    await ui.press({ key: 'ultra-review' })
    expect(asked).toEqual(['/code-review'])
    await ui.press({ key: 'confirm' })
    expect(asked).toEqual(['/code-review', '/code-review ultra'])
    await ui.unmount()
  }
})
