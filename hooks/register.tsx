import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit } from 'claude-code'

import type { Limit, Usage } from '../types'

const PANE = 'token-usage'
const TITLE = 'トークン使用量'
const BAR_WIDTH = 20
const LIMIT_GAP = 2
const usage = atom({ plugin: 'claude-mods', key: 'usage' } as const, {
  window: 0,
})

// The key of the button waiting on its confirmation, or null.
const armed = atom({ plugin: 'claude-mods', key: 'armed' } as const, null)

// True while the screenshot script waits for the person's click.
const isShooting = atom(
  { plugin: 'claude-mods', key: 'isShooting' } as const,
  false,
)
const SHOT_TIMEOUT_SECONDS = 30

type PaneCommand = {
  key: string
  label: string
  // The names it may run under, the first the session lists wins.
  names: string[]
  args?: string
  // Asked before it runs; absent, a press runs it at once.
  confirm?: string
}

// The commands the pane offers as buttons, in the order drawn; one the
// session does not list is left out.
const COMMANDS: PaneCommand[] = [
  {
    key: 'clear',
    label: '/clear',
    names: ['clear'],
    confirm: '会話をクリアしますか？',
  },
  { key: 'compact', label: '/compact', names: ['compact'] },
  { key: 'context', label: '/context', names: ['context'] },
  { key: 'cost', label: '/cost', names: ['cost'] },
  {
    key: 'review',
    label: '/review',
    names: ['review', 'code-review'],
    confirm: 'レビューを実行しますか？',
  },
  {
    key: 'ultra-review',
    label: 'Ultra Review',
    names: ['code-review'],
    args: 'ultra',
    confirm: 'Ultra Review を実行しますか？（クラウド実行・課金対象）',
  },
]
const COMMANDS_PER_ROW = 2

const formatTokens = (count: number) => count.toLocaleString('en-US')

const barColor = (percent: number) =>
  percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green'

const limitOf = (
  rateLimits: SessionRateLimit[],
  kind: string,
): Limit | undefined => {
  const limit = rateLimits.find(one => one.kind === kind)

  return limit && { percentUsed: limit.percentUsed, resetsAt: limit.resetsAt }
}

const formatReset = (iso: string) => {
  const at = new Date(iso)
  const minutes = String(at.getMinutes()).padStart(2, '0')

  return `${at.getMonth() + 1}/${at.getDate()} ${at.getHours()}:${minutes}`
}

const bar = (percent: number, width = BAR_WIDTH) => {
  const filled = Math.max(
    0,
    Math.min(width, Math.round((percent / 100) * width)),
  )

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: 'コンテキスト使用量・累計コスト・利用枠のペインを開く',
    })
    const { context, cost, rateLimits } = await $.session.usage()
    await update($, usage, () => ({
      tokens: context.tokens,
      window: context.window,
      percent: context.percent,
      usd: cost?.usd,
      fiveHour: limitOf(rateLimits, 'five_hour'),
      weekly: limitOf(rateLimits, 'seven_day'),
    }))
    void $.ui
      .open({ id: PANE, title: TITLE })
      .then(() => $.ui.invalidate('ui.render'))

    return next(e)
  })

  on('command.run', { command: 'tokens' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    $.ui.invalidate('ui.render')

    return { text: 'トークン使用量ペインを開きました。' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)

    if (e.id === PANE) {
      $.ui.invalidate('ui.render')
    }

    return closed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    if (await read($, isShooting)) {
      return (
        <Box>
          <Text color="yellow">
            撮りたいウィンドウをクリックし、範囲をドラッグしてください（Esc
            で中止）
          </Text>
        </Box>
      )
    }

    const isPlaced = (await $.ui.panes()).some(
      pane => pane.id === PANE && pane.isPlaced,
    )
    // The script waits for the next click, shoots the window under it and
    // leaves the image on the clipboard for the person to paste.
    const shoot = async () => {
      await update($, isShooting, () => true)
      try {
        const { exitCode, stdout } = await $.process.run(
          [
            'powershell.exe',
            '-NoProfile',
            '-STA',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            `${$.plugin.root}/scripts/window-shot.ps1`,
            '-TimeoutSeconds',
            String(SHOT_TIMEOUT_SECONDS),
          ],
          // The click and the range each wait that long.
          { timeoutMs: (SHOT_TIMEOUT_SECONDS * 2 + 15) * 1000 },
        )
        const outcome = stdout.trim()
        $.ui.toast(
          exitCode === 0
            ? 'スクリーンショットをコピーしました。Ctrl+V で貼り付けできます'
            : outcome.startsWith('CANCEL')
              ? 'スクリーンショットを中止しました'
              : outcome.startsWith('TIMEOUT')
                ? 'クリックがなかったため中止しました'
                : 'スクリーンショットを撮れませんでした',
        )
      } catch {
        $.ui.toast('スクリーンショットを撮れませんでした')
      } finally {
        await update($, isShooting, () => false)
      }
    }
    // The desktop app's own switch for this session; elsewhere the slash
    // command stands in for it. Auto mode's classifier refuses a call no model
    // turn made, so there the button asks Claude to make it.
    const remote = async () => {
      try {
        const result = await $.mcp.call('ccd_session_mgmt', 'set_remote_control', {
          session_id: 'self',
          enabled: true,
        })
        const text = result.content.find(block => block.type === 'text')?.text ?? ''
        $.ui.toast(
          result.isError
            ? `リモートにできませんでした: ${text}`
            : `リモートコントロール: ${text || 'on'}`,
        )
      } catch (mcpError) {
        await $.command
          .run({ command: 'remote-control' })
          .catch(() =>
            $.prompt.submit({
              text: 'リモートボタンを押しました。このセッションのリモートコントロールをオンにしてください。',
            }),
          )
          .catch(promptError =>
            $.ui.toast(
              `リモートにできませんでした: ${String(mcpError)} / ${String(promptError)}`,
            ),
          )
      }
    }

    return (
      <Box flexDirection="row" gap={1}>
        {/* The way back to the pane while it is closed or waits undrawn: a
            press is the person's own ask, so it is placed at any width. */}
        {!isPlaced && (
          <Button
            key="open-pane"
            label={`${TITLE}を開く`}
            onPress={async () => {
              await $.ui.open({ id: PANE, title: TITLE })
              $.ui.invalidate('ui.render')
            }}
          />
        )}
        <Button key="shoot" label="スクショ" onPress={() => void shoot()} />
        <Button key="remote" label="リモート" onPress={() => void remote()} />
      </Box>
    )
  })

  on('session.measure', async ($, e, next) => {
    const measured: Usage = {
      tokens: e.context.tokens,
      window: e.context.window,
      percent: e.context.percent,
      usd: e.cost?.usd,
      fiveHour: limitOf(e.rateLimits, 'five_hour'),
      weekly: limitOf(e.rateLimits, 'seven_day'),
    }
    await update($, usage, () => measured)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const listed = new Set((await $.command.list()).map(one => one.name))
    const commands = COMMANDS.filter(one =>
      one.names.some(name => listed.has(name)),
    )
    const armedKey = await read($, armed)
    const waiting = commands.find(one => one.key === armedKey)
    const run = (one: PaneCommand) => {
      const command = one.names.find(name => listed.has(name))!
      void $.command
        .run({ command, args: one.args })
        .catch(() => $.ui.toast(`${one.label} を実行できませんでした`))
    }
    const press = (one: PaneCommand) =>
      one.confirm ? update($, armed, () => one.key) : run(one)
    const commandRows = commands.reduce<PaneCommand[][]>(
      (rows, one, index) =>
        index % COMMANDS_PER_ROW === 0
          ? [...rows, [one]]
          : [...rows.slice(0, -1), [...rows[rows.length - 1]!, one]],
      [],
    )
    const { tokens, window, percent, usd, fiveHour, weekly } = await read(
      $,
      usage,
    )
    const half = Math.floor(((e.viewport?.columns ?? 44) - LIMIT_GAP) / 2)
    const limitBar = Math.max(4, Math.min(BAR_WIDTH, half - 2))
    const limitColumn = (title: string, limit: Limit | undefined) => (
      <Box flexDirection="column" width={half}>
        <Text bold>{title}</Text>
        {limit === undefined ? (
          <Text dimColor>計測待ち / 対象外</Text>
        ) : (
          <Box flexDirection="column">
            <Text color={barColor(limit.percentUsed)}>
              {bar(limit.percentUsed, limitBar)}
            </Text>
            <Text color={barColor(limit.percentUsed)}>
              {limit.percentUsed}% 使用
            </Text>
            <Text dimColor>
              残り {Math.max(0, Math.round((100 - limit.percentUsed) * 10) / 10)}%
            </Text>
            {limit.resetsAt && (
              <Text dimColor>リセット {formatReset(limit.resetsAt)}</Text>
            )}
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={LIMIT_GAP}>
          {limitColumn('5時間の利用枠', fiveHour)}
          {limitColumn('週間の利用枠', weekly)}
        </Box>
        <Text> </Text>
        <Text bold>コンテキスト</Text>
        {tokens === undefined || percent === undefined ? (
          <Text dimColor>
            計測待ち / {formatTokens(window)} トークン
          </Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              {formatTokens(tokens)} / {formatTokens(window)} トークン
            </Text>
            <Text color={barColor(percent)}>
              {bar(percent)} {percent}%
            </Text>
          </Box>
        )}
        <Text> </Text>
        <Text bold>累計コスト</Text>
        {usd === undefined ? (
          <Text dimColor>取得できません</Text>
        ) : (
          <Text>${usd.toFixed(2)}</Text>
        )}
        {commands.length > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold>コマンド</Text>
            {waiting ? (
              <Box flexDirection="column">
                <Text color="yellow">{waiting.confirm}</Text>
                <Box flexDirection="row" gap={1}>
                  <Button
                    key="confirm"
                    label="実行"
                    variant="primary"
                    onPress={async () => {
                      await update($, armed, () => null)
                      run(waiting)
                    }}
                  />
                  <Button
                    key="cancel"
                    label="やめる"
                    onPress={() => update($, armed, () => null)}
                  />
                </Box>
              </Box>
            ) : (
              commandRows.map(row => (
                <Box flexDirection="row" gap={1}>
                  {row.map(one => (
                    <Button
                      key={one.key}
                      label={one.label}
                      onPress={() => press(one)}
                    />
                  ))}
                </Box>
              ))
            )}
          </Box>
        )}
      </Box>
    )
  })
}
