import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AsideEntry } from '../types'

// A side question about the session that never enters the main conversation:
// a tool-less fork of the transcript answers it, served from the prompt cache.
// Ask in the pane's field; `/aside <question>` works too, but the command's
// record is a transcript row, so the field is the clean way.
// 2026-10-20 사용자: 옆 분할 창(새 Claude) 방식을 시험했지만 ✕로 닫는 이 방식이 편해서 되돌림

const PANE = 'aside'
const entries = atom({ plugin: 'aside', key: 'entries' } as const, [])

// 로컬 수정(2026-10-20 사용자 "가독성 높이고"): 답 모양을 사용자 읽기 습관(결론 먼저·짧게·용어 풀기)에 맞춘다
export const framed = (question: string) =>
  `Side question from the user, answered outside the main conversation, from what this session already contains. Do not plan or start work. ` +
  `Answer in the language of the question. The reader is a non-developer with ADHD: first line is the answer itself; then at most 3 short numbered points if needed; ` +
  `8 lines at most; explain any technical term in plain words; one concrete example when it helps. No preamble, no closing line.\n\n${question}`

async function ask($: EngineInterface, question: string) {
  const q = question.trim()
  if (!q) return
  await update($, entries, list => [...list, { question: q, answer: '', status: 'asking', cacheRead: 0, output: 0 } as AsideEntry].slice(-20))
  const r = await $.model.fork({ prompt: framed(q) })
  const usage = 'usage' in r ? r.usage : undefined
  const done: Partial<AsideEntry> = r.isAnswered
    ? { answer: r.text, status: 'done' }
    : { answer: `답을 못 받았어요: ${r.reason}`, status: 'failed' }
  await update($, entries, list =>
    list.map((x, i) => (i === list.length - 1 && x.question === q ? { ...x, ...done, cacheRead: usage?.cache_read_input_tokens ?? 0, output: usage?.output_tokens ?? 0 } : x)),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'aside', description: '이 대화를 아는 AI에게 옆 창에서 몰래 묻기 (본 대화엔 안 남음)', argumentHint: '[질문]', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'aside' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: '옆 질문', focus: true, closeOnEscape: true })
    await ask($, e.args)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>옆 질문은 터미널이나 데스크톱 앱에서만 돼요.</Text>
    }
    const { Box, Text, Input, Markdown } = $.ui.resolve(e)
    const list = await read($, entries)
    // 문답마다 Q 줄(강조색)과 들여 쓴 답, 사이에 구분선. 토큰 숫자 줄은 뺐다(비개발자에게 뜻 없음). 최근 3개만
    return (
      <Box flexDirection="column">
        <Text dimColor>이 대화를 아는 AI에게 몰래 묻기 · 본 대화엔 안 남아요</Text>
        {list.slice(-3).map((x, i) => (
          <Box key={`e-${i}`} flexDirection="column">
            <Text dimColor>{'─'.repeat(30)}</Text>
            <Text bold color="claude">{`Q. ${x.question}`}</Text>
            <Box marginLeft={3} flexDirection="column">
              {x.status === 'asking' ? <Text dimColor>생각 중…</Text> : <Markdown key={`a-${x.question.slice(0, 40)}`} text={x.answer} />}
            </Box>
          </Box>
        ))}
        {list.length > 0 && <Text dimColor>{'─'.repeat(30)}</Text>}
        <Input key="q" placeholder="물어볼 것을 쓰고 Enter" submitLabel="보내기" autoFocus onSubmit={value => void ask($, value)} />
      </Box>
    )
  })
}
