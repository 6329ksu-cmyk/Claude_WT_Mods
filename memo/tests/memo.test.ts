import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const memo = (args = '') => ({ command: 'memo', args })
const PATH = 'C:\\home\\.claude\\mods\\memo-data.json'

// 테스트에는 파일 시스템이 없으니 메모 파일을 메모리에 둔다
const disk = (on: On, sid = () => 'S1') => {
  const files = new Map<string, string>()
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('session.id', () => ({ value: sid() }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  // 폴더 목록: 그 폴더 바로 아래 파일만, 시각은 지금(살아 있는 세션으로 보인다)
  on('fs.list', ($, e) => {
    const dir = e.path.replace(/[\\/]+$/, '')
    const names = [...files.keys()].filter(k => k.startsWith(`${dir}\\`) && !k.slice(dir.length + 1).includes('\\'))
    return {
      value: names.map(k => ({ name: k.slice(dir.length + 1), kind: 'file' as const, size: files.get(k)!.length, mtimeMs: Date.now(), isLink: false })),
    }
  })
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  return files
}

const texts = (files: Map<string, string>, key: 'list' | 'done') =>
  (JSON.parse(files.get(PATH)!)[key] as { text: string }[]).map(m => m.text)

// 세션 칸 한 줄을 열(칸)별 글자로: 버튼은 빼고 왼쪽부터 [상태, 표시, 도구, 이름, 마지막, 하던 일]
type Found = { type?: string; children?: unknown[] }
const rowCells = async (ui: { find: (q: { key: string }) => Promise<Found | undefined> }, key: string) => {
  const out: string[] = []
  const textOf = (n: unknown): string =>
    typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as Found).children ?? []).map(textOf).join('') : ''
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    const el = n as Found
    if (el.type === 'Button') return
    if (el.type === 'Text') return void out.push(textOf(el))
    for (const c of el.children ?? []) walk(c)
  }
  walk(await ui.find({ key }))
  return out
}
// 세션 칸 한 줄의 글(버튼 빼고), 띄어쓰기를 하나로 줄인 것, 어떤 글자가 몇 번째 화면 칸에서 시작하는지
const rowText = async (ui: { find: (q: { key: string }) => Promise<Found | undefined> }, key: string) => (await rowCells(ui, key))[0] ?? ''
const flat = (t: string) => t.replace(/\s+/g, ' ').trim()
const colOf = (t: string, sub: string) => [...t.slice(0, t.indexOf(sub))].reduce((n, ch) => n + (/[ᄀ-ᅟ가-힣⏳]/.test(ch) ? 2 : 1), 0)
// 세션 칸 줄 순서(줄 key의 id)
const rowOrder = async (ui: { findAll: (q: { type: string }) => Promise<{ key?: string }[]> }) =>
  (await ui.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => k.startsWith('row-')).map(k => k.slice(4))

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const ITEM = /^ ?\d\. 메모\d$/
const label = async (ui: { find: (q: { key: string }) => Promise<{ text?: string } | undefined> }, key: string) =>
  (await ui.find({ key }))?.text

test('메모를 추가하고 해결하면 해결 목록으로 간다', async ($, on) => {
  disk(on)
  await $.command.run(memo('테스트 메모'))
  expect((await $.command.run(memo())).text).toContain('1. 테스트 메모')

  expect((await $.command.run(memo('done 1'))).text).toContain('해결함')
  expect((await $.command.run(memo())).text).toBe('미해결 메모 없음\n✓ 테스트 메모')
})

test('미해결은 오래된 것이 위, 해결은 최신이 위로 3개만 보인다', async ($, on) => {
  const files = disk(on)
  for (const n of [1, 2, 3, 4, 5]) await $.command.run(memo(`메모${n}`))
  for (let i = 0; i < 4; i++) await $.command.run(memo('done 1'))

  expect(texts(files, 'list')).toEqual(['메모5'])
  const lines = String((await $.command.run(memo())).text).split('\n')
  expect(lines.slice(1)).toEqual(['✓ 메모4', '✓ 메모3', '✓ 메모2'])
})

test('다른 세션이 그사이 추가한 메모를 지우지 않는다', async ($, on) => {
  const files = disk(on)
  await $.command.run(memo('여기서 쓴 메모'))
  const data = JSON.parse(files.get(PATH)!)
  data.list.push({ id: 1, text: '다른 세션 메모', at: '2026-10-06', session: 'S2' })
  files.set(PATH, JSON.stringify(data))

  await $.command.run(memo('done 1'))
  expect(texts(files, 'list')).toEqual(['다른 세션 메모'])
  expect(texts(files, 'done')).toEqual(['여기서 쓴 메모'])
})

test('메뉴판은 메모(전역·세션)·세션 칸을 그리고(기한·선택지 칸은 없음), 칸을 누르면 펼치고 다시 누르면 접는다', async ($, on) => {
  disk(on)
  for (const n of [1, 2, 3]) await $.command.run(memo(`메모${n}`))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'memo', surface, ...BAND })
    expect(await label(ui, 'tab-global')).toBe('전역 0')
    expect(await label(ui, 'tab-session')).toBe('세션 3')
    expect(await ui.find({ key: 'tab-due' })).toBeUndefined()
    expect(await ui.find({ key: 'tab-decide' })).toBeUndefined()
    expect(await label(ui, 'tab-desk')).toBe('보기')
    expect(await ui.findAll({ type: 'Text', text: ITEM })).toHaveLength(0)

    await ui.press({ key: 'tab-session' })
    expect(await ui.findAll({ type: 'Text', text: ITEM })).toHaveLength(3)
    await ui.press({ key: 'tab-session' })
    expect(await ui.findAll({ type: 'Text', text: ITEM })).toHaveLength(0)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-session' })
  const [first] = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('done-'))
  await ui.press({ key: first!.key! })
  expect(await ui.findAll({ type: 'Text', text: ITEM })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /✓ 메모1/ })).toBeDefined()
  expect(await label(ui, 'tab-session')).toBe('세션 2')
})

test('다음 말을 보내면 펼친 칸이 접힌다', async ($, on) => {
  disk(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.command.run(memo('메모1'))

  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-session' })
  expect(await ui.findAll({ type: 'Text', text: ITEM })).toHaveLength(1)

  await $.prompt.submit({ text: '다음 질문' })
  await ui.redraw()
  expect(await ui.findAll({ type: 'Text', text: ITEM })).toHaveLength(0)
})

test('Claude가 번호나 문구로 메모를 해결한다', async ($, on) => {
  disk(on)
  for (const n of [1, 2, 3]) await $.command.run(memo(`메모${n}`))

  expect((await $.tool.call({ tool: 'mcp__memo__done', match: '2' })).result).toBe('해결함: 메모2')
  expect((await $.tool.call({ tool: 'mcp__memo__done', match: '메모3' })).result).toBe('해결함: 메모3')
  expect(String((await $.tool.call({ tool: 'mcp__memo__done', match: '없는것' })).result)).toContain('지금 미해결: 1. 메모1')
})

test('없는 번호는 해결하지 않는다', async ($, on) => {
  disk(on)
  expect((await $.command.run(memo('done 9'))).text).toContain('없습니다')
})

test('다른 세션에서 적은 메모는 이 세션 메뉴판·목록·번호에 안 나온다', async ($, on) => {
  const files = disk(on)
  files.set(PATH, JSON.stringify({
    list: [{ id: 1, text: '남의 메모', at: '2026-10-06', session: 'S2' }, { id: 2, text: '세션 없는 옛 메모', at: '2026-10-06' }],
    done: [{ id: 3, text: '남의 해결', at: '2026-10-06', session: 'S2' }],
  }))
  expect((await $.command.run(memo())).text).toBe('미해결 메모 없음')
  expect((await $.command.run(memo('done 1'))).text).toContain('없습니다')

  expect((await $.tool.call({ tool: 'mcp__memo__add', text: '내 메모' })).result).toBe(
    '이 세션 메모 추가함 (이 세션 1건·전역 0건·기한 0건): 내 메모',
  )
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  expect(await label(ui, 'tab-session')).toBe('세션 1')
  expect(texts(files, 'list')).toEqual(['남의 메모', '세션 없는 옛 메모', '내 메모'])
})

test('다른 세션에서 적은 전역 메모는 이 세션에도 전1로 보이고 전1로 해결한다', async ($, on) => {
  const files = disk(on)
  files.set(PATH, JSON.stringify({
    list: [{ id: 1, text: '전역 할 일', at: '2026-10-07', session: 'S2', global: true }],
    done: [],
  }))
  await $.command.run(memo('세션 할 일'))

  const lines = String((await $.command.run(memo())).text).split('\n')
  expect(lines[0]).toMatch(/^1\. 세션 할 일 \(/)
  expect(lines[1]).toBe('전1. 전역 할 일 (2026-10-07)')

  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  expect(await label(ui, 'tab-global')).toBe('전역 1')
  await ui.press({ key: 'tab-global' })
  expect(await ui.find({ type: 'Text', text: /^ ?전1\. 전역 할 일$/ })).toBeDefined()

  expect((await $.command.run(memo('done 전1'))).text).toBe('해결함: 전역 할 일')
  expect(texts(files, 'list')).toEqual(['세션 할 일'])
})

test('전역으로 넣은 메모는 global로 저장된다', async ($, on) => {
  const files = disk(on)
  expect((await $.command.run(memo('전역 서약서 독촉'))).text).toBe('전역 메모 추가함 (이 세션 0건·전역 1건·기한 0건)')
  expect((await $.tool.call({ tool: 'mcp__memo__add', text: '견적 비교', scope: 'global' })).result).toBe(
    '전역 메모 추가함 (이 세션 0건·전역 2건·기한 0건): 견적 비교',
  )
  const saved = JSON.parse(files.get(PATH)!).list as { text: string; global?: boolean }[]
  expect(saved.map(m => [m.text, m.global])).toEqual([['서약서 독촉', true], ['견적 비교', true]])
  expect((await $.tool.call({ tool: 'mcp__memo__done', match: '전2' })).result).toBe('해결함: 견적 비교')
})

test('기한 메모는 전역 칸 맨 위에 날짜 순으로 기1·기2가 되고, 지난 기한은 D+로 보인다', async ($, on) => {
  const files = disk(on)
  expect((await $.command.run(memo('기한 2099-12-31 먼 일'))).text).toBe('기한(2099-12-31) 메모 추가함 (이 세션 0건·전역 0건·기한 1건)')
  expect((await $.tool.call({ tool: 'mcp__memo__add', text: '지난 일', due: '2000-01-01' })).result).toBe(
    '기한(2000-01-01) 메모 추가함 (이 세션 0건·전역 0건·기한 2건): 지난 일',
  )
  expect((await $.command.run(memo('기한 내일모레 뭔가'))).text).toContain('날짜를')

  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  expect(await label(ui, 'tab-global')).toMatch(/^전역 2 · D\+\d+$/)
  await ui.press({ key: 'tab-global' })
  expect(await ui.find({ type: 'Text', text: /^ ?기1\. D\+\d+ 01-01 지난 일$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ ?기2\. D-\d+ 12-31 먼 일$/ })).toBeDefined()

  expect((await $.command.run(memo('done 기1'))).text).toBe('해결함: 지난 일')
  expect(texts(files, 'list')).toEqual(['먼 일'])
})

test('세션 칸은 desk_json.py 결과를 그리고 버튼에 실행 중·꺼짐 개수를 보인다', async ($, on) => {
  const files = disk(on)
  // 이 PC 원본이 있으면 그것을 쓴다(아래 [끝]). desk_json.py 원본은 없으니 mod에 담긴 사본을 py 런처로 부른다
  files.set('C:\\home\\.claude\\scripts\\recent_sessions.py', '')
  const NAC = '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  let rows = [
    { id: '1111aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tool: 'claude', name: '메모', live: true, state: '답 기다림', last: '10-07 14:00', win: 2 },
    { id: NAC, tool: 'codex', name: 'NAC정책정리', live: false, state: '작업 중 끊김', last: '10-07 13:00' },
  ]
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (!e.argv.includes('--done')) return { value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' } }
    rows = rows.filter(r => r.id !== NAC)
    return { value: { exitCode: 0, stdout: `끝남으로 표시: NAC정책정리 (${NAC.slice(0, 8)})\n`, stderr: '' } }
  })

  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-desk' })
  expect(await label(ui, 'tab-desk')).toBe('● 1  ○ 1')
  expect(ran[0]!.slice(0, 2)).toEqual(['py', '-3'])
  expect(ran[0]![2]).toMatch(/[\\/]scripts\\desk_json\.py$/)
  // 한 줄 모양 그대로, 실행 중이면 시각을 뺀다. 머리줄은 없다
  const me = await rowText(ui, 'row-1111aaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  const nac = await rowText(ui, `row-${NAC}`)
  // 창이 여럿이면 실행 중인 줄에 창 번호, 꺼진 줄은 그 칸을 비운다
  expect(flat(me)).toBe('● 실행 중 · 창2 · 메모')
  expect(flat(nac)).toBe('○ 꺼짐 · Codex · NAC정책정리 (10-07 13:00)')
  expect(await ui.find({ key: 'desk-head' })).toBeUndefined()
  // 열 맞춤: 상태 칸이 '● 실행 중'(9칸)과 '○ 꺼짐'(6칸)으로 길이가 달라도 이름은 같은 칸에서 시작한다
  expect(colOf(me, '메모')).toBe(colOf(nac, 'NAC정책정리'))

  // [끝]은 recent_sessions.py --done <전체 id>를 부르고, 그 줄을 목록에서 뺀다
  await ui.press({ key: `end-${NAC}` })
  expect(ran.at(-1)!.slice(-3)).toEqual(['C:/home\\.claude\\scripts\\recent_sessions.py', '--done', NAC])
  expect(await ui.find({ type: 'Text', text: /NAC정책정리/ })).toBeUndefined()
  expect(await label(ui, 'tab-desk')).toBe('● 1  ○ 0')
})

test('세션 칸 [킵]은 recent_sessions.py --keep을 부르고 그 줄을 아래로 내려 ⏸ 킵으로 보인다, [풀기]로 되돌린다', async ($, on) => {
  disk(on)
  const A = '1111aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const B = '2222aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const rows = [
    { id: A, tool: 'claude', name: '급한일', live: true, state: '답 기다림', last: '10-08 13:00' },
    { id: B, tool: 'claude', name: '나중일', live: true, state: '답 기다림', last: '10-08 12:00' },
  ]
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const flag = e.argv.find(a => a === '--keep' || a === '--unkeep')
    if (!flag) return { value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' } }
    const text = flag === '--keep' ? `킵으로 표시: 나중일 (${A.slice(0, 8)})` : `킵 표시 해제: 나중일 (${A.slice(0, 8)})`
    return { value: { exitCode: 0, stdout: `${text}\n`, stderr: '' } }
  })

  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-desk' })
  await ui.press({ key: `keep-${A}` })
  expect(ran.at(-1)!.slice(-2)).toEqual(['--keep', A])
  expect(await rowOrder(ui)).toEqual([B, A])
  expect(flat(await rowText(ui, `row-${A}`))).toBe('● 실행 중 · ⏸ 킵 · 급한일 (10-08 13:00)')  // 킵은 실행 중이어도 시각을 남긴다
  expect((await ui.find({ key: `keep-${A}` }))?.text).toContain('풀기')

  await ui.press({ key: `keep-${A}` })
  expect(ran.at(-1)!.slice(-2)).toEqual(['--unkeep', A])
  expect(await ui.find({ type: 'Text', text: /⏸ 킵/ })).toBeUndefined()
})

test('세션 칸 [열기]는 꺼진 줄에만 있고(킵이어도) recent_sessions.py --open-id를 부른다, 바로 또 눌러도 한 번만 연다', async ($, on) => {
  disk(on)
  const A = '1111aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const B = '2222aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const rows = [
    { id: A, tool: 'claude', name: '켜진 일', live: true, state: '', last: '10-13 10:00' },
    { id: B, tool: 'claude', name: '서약서 취합', live: false, kept: true, state: '답변 후 대기', last: '10-13 09:47' },
  ]
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (e.argv.includes('--open-id')) return { value: { exitCode: 0, stdout: '1개 탭을 새 Windows Terminal 창으로 열었습니다.', stderr: '' } }
    return { value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' } }
  })

  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-desk' })
  expect(await ui.find({ key: `open-${A}` })).toBeUndefined()
  await ui.press({ key: `open-${B}` })
  expect(ran.at(-1)!.slice(-2)).toEqual(['--open-id', B])
  await ui.press({ key: `open-${B}` })
  expect(ran.filter(a => a.includes('--open-id')).length).toBe(1)
})

test('세션 칸 [더 보기]는 desk_json.py를 72시간으로 다시 읽고, [하루만]으로 되돌린다', async ($, on) => {
  disk(on)
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const old = e.argv.includes('72') ? [{ id: 'OLD', tool: 'claude', name: '금요일 일', live: false, state: '', last: '10-10 17:00' }] : []
    return { value: { exitCode: 0, stdout: JSON.stringify([{ id: 'S1', tool: 'claude', name: 'Memo', live: true, state: '', last: '10-13 14:00' }, ...old]), stderr: '' } }
  })
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-desk' })
  expect(await rowOrder(ui)).toEqual(['S1'])
  await ui.press({ key: 'desk-more' })
  expect(ran.at(-1)!.at(-1)).toBe('72')
  expect(await rowOrder(ui)).toEqual(['S1', 'OLD'])
  expect(await label(ui, 'desk-more')).toContain('하루만')
  await ui.press({ key: 'desk-more' })
  expect(ran.at(-1)!.at(-1)).toMatch(/desk_json\.py$/)
  expect(await rowOrder(ui)).toEqual(['S1'])
})

test('같은 탭에서 세션 번호가 바뀌면 5초 안에 그 세션 메모로 다시 그린다', async ($, on) => {
  let sid = 'S0'
  const files = disk(on, () => sid)
  const clock = mock.clock(on)
  files.set(PATH, JSON.stringify({ list: [{ id: 1, text: '메모1', at: '2026-10-08', session: 'S1' }], done: [] }))
  on('session.start', () => ({ cwd: 'C:/home' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('fs.stat', () => ({ deny: '없음' }))
  await $.session.start({ cwd: 'C:/home', surface: 'terminal' })
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  expect(await label(ui, 'tab-session')).toBe('세션 0')

  sid = 'S1'
  await clock.advance(5000)
  await ui.redraw()
  expect(await label(ui, 'tab-session')).toBe('세션 1')
})

test('세션 칸: 이 세션이 맨 위 ▶ 지금으로 보이고, 그 줄의 [끝]·[킵]으로 바로 정한다', async ($, on) => {
  disk(on)
  const rows = [
    { id: 'S2', tool: 'codex', name: 'DDoS IPS Rule', live: true, state: '답변 후 대기', last: '10-08 16:20' },
    { id: 'S1', tool: 'claude', name: 'Memo', live: true, state: '답 기다림', last: '10-08 16:30' },
  ]
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (e.argv.includes('--keep')) return { value: { exitCode: 0, stdout: '킵으로 표시: Memo (S1)\n', stderr: '' } }
    if (e.argv.includes('--done')) return { value: { exitCode: 0, stdout: '끝남으로 표시: Memo (S1)\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' } }
  })
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-desk' })
  // 목록에서도 이 세션이 맨 위, ▶ 지금 표시
  expect((await rowOrder(ui))[0]).toBe('S1')
  expect(flat(await rowText(ui, 'row-S1'))).toBe('● 실행 중 · ▶ 지금 · Memo')  // 실행 중이면 시각을 뺀다
  const mine = (await ui.find({ type: 'Text', text: /▶ 지금/ })) as { props?: Record<string, unknown> }
  expect(mine.props?.backgroundColor).toBe('claude')

  await ui.press({ key: 'keep-S1' })
  expect(ran.at(-1)!.slice(-2)).toEqual(['--keep', 'S1'])
  expect((await ui.find({ key: 'keep-S1' }))?.text).toContain('풀기')

  await ui.press({ key: 'end-S1' })
  expect(ran.at(-1)!.slice(-2)).toEqual(['--done', 'S1'])
  expect(await ui.find({ key: 'end-S1' })).toBeUndefined()
})

test('세션 칸 [새로고침]은 desk_json.py를 지금 다시 읽어 목록을 바꾼다', async ($, on) => {
  disk(on)
  let rows = [{ id: 'A', tool: 'claude', name: '옛 세션', live: true, state: '답 기다림', last: '10-12 08:00' }]
  let calls = 0
  on('process.run', () => {
    calls++
    return { value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' } }
  })
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-desk' })
  expect(await ui.find({ type: 'Text', text: /옛 세션/ })).toBeDefined()

  rows = [{ id: 'B', tool: 'codex', name: '새 세션', live: true, state: '답변 후 대기', last: '10-12 08:40' }]
  const before = calls
  await ui.press({ key: 'desk-refresh' })
  expect(calls).toBe(before + 1)
  expect(await ui.find({ type: 'Text', text: /옛 세션/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Codex · 새 세션/ })).toBeDefined()
})

test('세션 칸 "최근 끝낸" 버튼: 끝낸 세션을 펼쳐 보고 [되살리기]로 목록에 되돌린다', async ($, on) => {
  disk(on)
  const rows = [
    { id: 'A', tool: 'claude', name: '하는 중', live: true, state: '답 기다림', last: '10-12 09:00' },
    { id: 'B', tool: 'codex', name: '끝낸 일', live: false, state: '답변 후 대기', last: '10-08 16:35', done: true },
  ]
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (e.argv.includes('--undone')) return { value: { exitCode: 0, stdout: '끝남 표시 해제: 끝낸 일 (B)\n', stderr: '' } }
    if (e.argv.includes('--done')) return { value: { exitCode: 0, stdout: '끝남으로 표시: 하는 중 (A)\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' } }
  })
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-desk' })
  expect(await label(ui, 'tab-desk')).toBe('● 1  ○ 0')  // 끝낸 세션은 개수에서 뺀다
  expect(await ui.find({ type: 'Text', text: /끝낸 일/ })).toBeUndefined()

  await ui.press({ key: 'desk-ended' })
  expect(flat(await rowText(ui, 'ended-B'))).toBe('✓ 끝냄 · Codex · 끝낸 일 (10-08 16:35)')

  // [끝]을 누르면 그 세션이 '최근 끝낸' 맨 앞으로 간다
  await ui.press({ key: 'end-A' })
  expect((await label(ui, 'desk-ended'))).toContain('최근 끝낸 2')
  const ended = (await ui.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => k.startsWith('ended-'))
  expect(ended[0]).toBe('ended-A')

  await ui.press({ key: 'revive-B' })
  expect(ran.at(-1)!.slice(-2)).toEqual(['--undone', 'B'])
  expect(flat(await rowText(ui, 'row-B'))).toBe('○ 꺼짐 · Codex · 끝낸 일 (10-08 16:35)')
})

test('흐름 칸: 처음 열면 대화 전체를 요약해 목표·흐름·지금·다음으로 보여 주고, 다시 열면 저장본과 새 대화 수를 보인다', async ($, on) => {
  const files = disk(on)
  let msgs = [
    { role: 'user', text: '메모를 세션별로 보이게 해줘', toolUses: [] },
    { role: 'user', text: '<system-reminder>무시</system-reminder>', toolUses: [] },
    { role: 'assistant', text: '세션별로 바꿨어요', toolUses: [] },
  ]
  on('session.messages', () => ({ value: msgs }))
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    const text = JSON.stringify({ goal: '메모 mod 고도화', steps: ['메모를 세션별로', '세션 칸 킵'], now: '흐름 칸 시험 중', next: '창 번호 결정' })
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-flow' })
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('사용자: 메모를 세션별로 보이게 해줘')
  expect(asked[0]).not.toContain('system-reminder')
  expect(await ui.find({ type: 'Text', text: /^메모 mod 고도화$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1\. 메모를 세션별로$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▶ 흐름 칸 시험 중$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^→ 창 번호 결정$/ })).toBeDefined()
  // 세션마다 파일 하나
  expect(JSON.parse(files.get('C:\\home\\.claude\\mods\\memo-flow\\S1.json')!).goal).toBe('메모 mod 고도화')
  // 내 질문: 시스템 글은 빼고 사용자가 보낸 말만
  expect(await ui.find({ type: 'Text', text: /^ 내 질문 1개/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ 메모를 세션별로 보이게 해줘$/ })).toBeDefined()

  // 다시 열면 요약을 또 만들지 않고, 그 뒤 새 대화 수만 알려 준다. [다시 요약]을 누르면 새로 만든다
  await ui.press({ key: 'tab-flow' })
  msgs = [...msgs, { role: 'user', text: '창 번호 넣어', toolUses: [] }]
  await ui.press({ key: 'tab-flow' })
  expect(asked).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /그 뒤 대화 1개/ })).toBeDefined()
  await ui.press({ key: 'flow-redo' })
  expect(asked).toHaveLength(2)
})

test('흐름 칸: 요약이 실패하면 이유를 보이고 저장하지 않는다', async ($, on) => {
  const files = disk(on)
  on('session.messages', () => ({ value: [{ role: 'user', text: '안녕', toolUses: [] }] }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '모르겠어요', usage: { input_tokens: 1, output_tokens: 1 } } }))
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-flow' })
  expect(await ui.find({ type: 'Text', text: /요약 실패: 답 형식이 이상해요/ })).toBeDefined()
  expect(files.has('C:\\home\\.claude\\mods\\memo-flow\\S1.json')).toBe(false)
})

test('흐름 자동 갱신: 답이 끝나면 이전 요약 + 방금 대화로 고치고, 기다리는 답이 있으면 상태판에 답 기다림을 적는다', async ($, on) => {
  const files = disk(on)
  files.set(
    'C:\\home\\.claude\\mods\\memo-flow\\S1.json',
    JSON.stringify({ at: '10-12 13:00', count: 2, goal: '메모 mod 고도화', steps: ['흐름 칸 만들기'], now: '흐름 칸 시험', waiting: '', next: '' }),
  )
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '흐름 칸 만들어', toolUses: [] },
      { role: 'assistant', text: '만들었어요', toolUses: [] },
      { role: 'user', text: '남들 mod 1~4 적용해줘', toolUses: [] },
    ],
  }))
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    const text = JSON.stringify({
      goal: '메모 mod 고도화',
      steps: ['흐름 칸 만들기', '남들 mod 아이디어 적용'],
      now: '1~4번 적용 끝',
      waiting: '흐름 칸을 눌러 확인해 주세요',
      next: '',
    })
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('session.start', () => ({ cwd: 'C:/home' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: 'C:/home', surface: 'terminal' })
  await $.turn.complete({ answer: '1~4번 적용했어요. 흐름 칸을 눌러 확인해 주세요.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  // 전체를 다시 읽지 않고 이전 요약과 방금 대화만 보낸다
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('<이전 요약>')
  expect(asked[0]).toContain('사용자: 남들 mod 1~4 적용해줘')
  expect(asked[0]).not.toContain('흐름 칸 만들어')
  const saved = JSON.parse(files.get('C:\\home\\.claude\\mods\\memo-flow\\S1.json')!)
  expect(saved.steps).toEqual(['흐름 칸 만들기', '남들 mod 아이디어 적용'])
  const live = JSON.parse(files.get('C:\\home\\.claude\\mods\\memo-live\\S1.json')!)
  expect(live.state).toBe('waiting')
  expect(live.why).toBe('흐름 칸을 눌러 확인해 주세요')

  // 칸이 닫혀 있으면 메뉴판 아래에 목표·지금만 늘 보인다(기다리는 답 줄 없음)
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /1~4번 적용 끝/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /기다리는 답:/ })).toBeUndefined()
})

test('답 기다림: 다른 세션이 답을 기다리면 세션 칸 맨 위에만 보이고(메뉴판 ⏳ 줄 없음), 오래 안 바뀐 세션은 뺀다', async ($, on) => {
  const files = disk(on)
  const at = new Date(2026, 9, 12, 13, 5).getTime()
  files.set('C:\\home\\.claude\\mods\\memo-live\\S2.json', JSON.stringify({ id: 'S2', state: 'waiting', why: 'PPT 표지 골라 주세요', since: at, name: '품의 PPT' }))
  files.set('C:\\home\\.claude\\mods\\memo-live\\S3.json', JSON.stringify({ id: 'S3', state: 'working', why: '', since: at, name: '다른 일' }))
  const rows = [
    { id: 'S3', tool: 'claude', name: '다른 일', live: true, state: '', last: '10-12 13:00' },
    { id: 'S2', tool: 'claude', name: '품의 PPT 만들기', live: true, state: '', last: '10-12 13:05' },
    { id: 'S1', tool: 'claude', name: 'Memo', live: true, state: '', last: '10-12 13:06' },
  ]
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' } }))
  on('session.start', () => ({ cwd: 'C:/home' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  await $.session.start({ cwd: 'C:/home', surface: 'terminal' })
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-desk' })
  expect(await ui.find({ type: 'Text', text: /답 기다리는 다른 세션/ })).toBeUndefined()
  expect(await label(ui, 'tab-desk')).toBe('● 3  ○ 0')
  expect(await rowOrder(ui)).toEqual(['S1', 'S2', 'S3'])
  expect(flat(await rowText(ui, 'row-S2'))).toBe('● 실행 중 · 품의 PPT 만들기 — PPT 표지 골라 주세요')
  // 이 세션 자기 상태 파일도 만든다(다른 세션이 읽는다)
  expect(JSON.parse(files.get('C:\\home\\.claude\\mods\\memo-live\\S1.json')!).state).toBe('idle')
})

test('세션 칸 줄 끝에 그 세션이 하던 일: 흐름 요약의 기다리는 답·지금, 요약 없는 세션은 마지막 요청', async ($, on) => {
  const files = disk(on)
  files.set('C:\\home\\.claude\\mods\\memo-flow\\A.json', JSON.stringify({ at: '10-12 15:00', count: 4, goal: 'DHCP 정리', steps: [], now: '노트북 고정 목록 뽑음', waiting: '1번 진행할지 승인', next: '' }))
  files.set('C:\\home\\.claude\\mods\\memo-flow\\B.json', JSON.stringify({ at: '10-12 15:01', count: 4, goal: '서약서 취합', steps: [], now: '2차 요청 회신 정리 중', waiting: '', next: '' }))
  const rows = [
    { id: 'A', tool: 'claude', name: 'DHCP', live: true, state: '', last: '10-12 15:00' },
    { id: 'B', tool: 'claude', name: '서약서 취합', live: true, state: '', last: '10-12 15:01' },
    { id: 'C', tool: 'codex', name: 'KISA보안훈련', live: false, state: '', last: '10-12 11:00', last_user: '결과보고 양식\n찾아줘' },
  ]
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' } }))
  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tab-desk' })
  const a = await rowText(ui, 'row-A')
  const c = await rowText(ui, 'row-C')
  expect(flat(a)).toBe('● 실행 중 · DHCP — 1번 진행할지 승인')
  expect(flat(await rowText(ui, 'row-B'))).toBe('● 실행 중 · 서약서 취합 — 2차 요청 회신 정리 중')
  expect(flat(c)).toBe('○ 꺼짐 · Codex · KISA보안훈련 (10-12 11:00) — 마지막 요청: 결과보고 양식 찾아줘')
  // 이름 길이·시각 유무가 달라도 하던 일(—)은 같은 칸에서 시작한다
  expect(colOf(a, '—')).toBe(colOf(c, '—'))
})

test('사용량 줄: 맨 아래에 5h·주 한도·대화칸·모델·effort·세션을 한 줄로, 90% 넘으면 한도마다 한 번 알린다', async ($, on) => {
  disk(on)
  // 30초 여유: 분 단위로 내림해도 1h40·1h05로 보인다
  const soon = (min: number) => new Date(Date.now() + min * 60_000 + 30_000).toISOString()
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, percent: 21 },
      rateLimits: [
        { kind: 'seven_day', percentUsed: 31.2, resetsAt: soon(9000) },
        { kind: 'five_hour', percentUsed: 63.4, resetsAt: soon(100) },
      ],
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: { effortLevel: 'xhigh' } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: 'C:/home' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: 'C:/home', surface: 'terminal' })
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  const line = async () => (await ui.find({ type: 'Text', text: /^⏱/ }))?.text
  expect(await line()).toBe('⏱ 5h ███░░ 63% · 1h40 남음 · 주 █▌░░░ 31% · 대화칸 21% · Opus 5.5 XHIGH · S1')
  // 칸을 열어도 남는다
  await ui.press({ key: 'tab-session' })
  expect(await line()).toBeDefined()

  const measure = (percentUsed: number, min: number) =>
    $.session.measure({ context: { window: 1_000_000, percent: 22 }, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: soon(min) }], changed: ['rateLimits'] })
  await measure(92, 65)
  await measure(93, 64)
  expect(toasts).toEqual(['5h 한도 92% — 1h05 뒤 초기화'])
  await ui.redraw()
  expect(await line()).toMatch(/^⏱ 5h ████▌ 93% · 1h04 남음 · 대화칸 22%/)
  // 초기화되어 내려갔다가 다시 넘으면 또 알린다
  await measure(5, 300)
  await measure(91, 30)
  expect(toasts).toHaveLength(2)
})

test('결정 카드: 방금 답이 고르라고 하면 입력창 위에 고를 것·선택지 뜻이 남고, [왜? 앞뒤]로 앞 흐름·고르면 생길 일·추천 이유를 펼친다', async ($, on) => {
  const files = disk(on)
  files.set(
    'C:\\home\\.claude\\mods\\memo-flow\\S1.json',
    JSON.stringify({ at: '10-20 13:00', count: 2, goal: '세션 칸 고도화', steps: ['창 번호 조사'], now: '창 번호 설명', waiting: '', next: '' }),
  )
  on('session.messages', () => ({ value: [{ role: 'user', text: '창 번호가 뭐야', toolUses: [] }] }))
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    const text = JSON.stringify({
      goal: '세션 칸 고도화',
      steps: ['창 번호 조사'],
      now: '창 번호 설명',
      waiting: '창 번호 A/B',
      next: '',
      decisions: [
        {
          ask: '세션 칸에 창 번호 넣을지',
          why: '창이 2개라 세션이 어느 창인지 몰라서',
          options: [
            { key: 'A', label: '넣기', then: '줄마다 창2가 붙음' },
            { key: 'B', label: '안 넣기', then: '지금 그대로' },
          ],
          pick: 'A',
          reason: '10-12에 직접 물어본 기능',
        },
        { ask: '선택지 없는 질문', options: [] },
      ],
    })
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('session.start', () => ({ cwd: 'C:/home' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: 'C:/home', surface: 'terminal' })
  const long = `${'설명 '.repeat(1500)}창 번호를 A(넣기)로 할지 B(안 넣기)로 할지 알려 주세요.`
  await $.turn.complete({ answer: long, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  // 긴 답이어도 끝의 고르라는 말이 요약 재료에 들어간다
  expect(asked[0]).toContain('B(안 넣기)로 할지 알려 주세요')

  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  // 선택지 없는 항목은 버리고, 한 줄에 고를 것과 선택지 뜻·추천(★)
  expect(await ui.findAll({ type: 'Text', text: /^❓ .+ — / })).toHaveLength(1)
  expect(flat((await ui.find({ type: 'Text', text: /^❓ .+ — / }))!.text)).toBe('❓ 세션 칸에 창 번호 넣을지 — A 넣기 ★ · B 안 넣기')
  await ui.press({ key: 'why' })
  expect(await ui.find({ type: 'Text', text: /^앞: 창이 2개라 세션이 어느 창인지 몰라서$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^A 넣기 ★ → 줄마다 창2가 붙음$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^★ 추천 이유: 10-12에 직접 물어본 기능$/ })).toBeDefined()
  // 답을 보내면 카드가 내려간다
  await $.prompt.submit({ text: 'A' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^❓/ })).toBeUndefined()
})

test('흐름이 길어져도 글자 수 상한으로 자르고, 고치기 답이 깨지면 처음부터 다시 요약해 멈추지 않는다', async ($, on) => {
  const files = disk(on)
  const long = '가'.repeat(300)
  files.set(
    'C:\\home\\.claude\\mods\\memo-flow\\S1.json',
    JSON.stringify({ at: '10-20 10:51', count: 2, goal: '목표', steps: [long], now: long, waiting: '', next: '' }),
  )
  on('session.messages', () => ({ value: [{ role: 'user', text: '다음 일', toolUses: [] }] }))
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    // 첫 호출(고치기)은 토큰 한도에서 잘린 JSON, 둘째(전체 요약)는 길게 쓴 정상 JSON
    const text = asked.length === 1 ? '{"goal": "목표", "steps": ["가가가' : JSON.stringify({ goal: '목표', steps: [long, '둘째'], now: long, waiting: '', next: '' })
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('session.start', () => ({ cwd: 'C:/home' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: 'C:/home', surface: 'terminal' })
  await $.turn.complete({ answer: '했어요', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  // 이전 요약은 잘라서 보내고, 깨진 답 뒤에는 전체 요약을 한 번 더 부른다
  expect(asked).toHaveLength(2)
  expect(asked[0]).not.toContain('가'.repeat(80))
  expect(asked[1]).toContain('<대화>')
  const saved = JSON.parse(files.get('C:\\home\\.claude\\mods\\memo-flow\\S1.json')!)
  expect(saved.steps).toEqual([`${'가'.repeat(49)}…`, '둘째'])
  expect(saved.now).toHaveLength(80)
})

test('코드를 다시 불러와 끊긴 흐름 갱신은 다시 불러온 뒤(session.start) 마지막 답으로 이어서 하고, 이미 반영한 답이면 다시 부르지 않는다', async ($, on) => {
  const files = disk(on)
  files.set('C:\\home\\.claude\\mods\\memo-flow\\S1.json', JSON.stringify({ at: '10-20 10:51', count: 2, goal: '목표', steps: ['하나'], now: '지금', waiting: '', next: '' }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '골라줘', toolUses: [] },
      { role: 'assistant', text: 'A와 B 중 고르세요', toolUses: [] },
    ],
  }))
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    const text = JSON.stringify({ goal: '목표', steps: ['하나', '둘'], now: '고르는 중', waiting: 'A·B 중 고르기', next: '' })
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('session.start', () => ({ cwd: 'C:/home' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: 'C:/home', surface: 'terminal' })
  await clock.settle()

  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('<이전 요약>')
  expect(asked[0]).toContain('AI: A와 B 중 고르세요')
  const saved = JSON.parse(files.get('C:\\home\\.claude\\mods\\memo-flow\\S1.json')!)
  expect(saved.steps).toEqual(['하나', '둘'])
  expect(saved.of).toBe('A와 B 중 고르세요')

  await $.session.start({ cwd: 'C:/home', surface: 'terminal' })
  await clock.settle()
  expect(asked).toHaveLength(1)
})

test('돌아오면 3줄 브리핑: 모든 탭에서 15분 넘게 안 보냈으면 그사이 답 기다림·끝남이 된 다른 탭을 메뉴판 아래 보이고, 말을 보내면 사라진다', async ($, on) => {
  const files = disk(on)
  const now = Date.now()
  const min = 60_000
  files.set('C:\\home\\.claude\\mods\\memo-live\\S1.json', JSON.stringify({ id: 'S1', state: 'idle', why: '', since: now - 40 * min, name: 'Memo', typed: now - 42 * min }))
  files.set('C:\\home\\.claude\\mods\\memo-live\\S2.json', JSON.stringify({ id: 'S2', state: 'idle', why: '', since: now - 30 * min, name: '서약서 취합', typed: now - 50 * min, doing: '회신 339건 정리 끝' }))
  files.set('C:\\home\\.claude\\mods\\memo-live\\S3.json', JSON.stringify({ id: 'S3', state: 'waiting', why: 'A·B 골라 주세요', since: now - 10 * min, name: 'DHCP 220번', doing: '예약 이전 A·B 고르기' }))
  // 비우기 전에 이미 기다리던 탭·아직 하는 중인 탭은 빠진다
  files.set('C:\\home\\.claude\\mods\\memo-live\\S4.json', JSON.stringify({ id: 'S4', state: 'waiting', why: '', since: now - 60 * min, name: '옛 질문' }))
  files.set('C:\\home\\.claude\\mods\\memo-live\\S5.json', JSON.stringify({ id: 'S5', state: 'working', why: '', since: now - 5 * min, name: '도는 중' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const rows = [{ id: 'S3', tool: 'claude', name: 'DHCP 220번', live: true, state: '', last: '10-20 13:00', win: 2 }]
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' } }))
  on('session.start', () => ({ cwd: 'C:/home' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: 'C:/home', surface: 'terminal' })
  await clock.advance(5000)

  const ui = await $.ui.mount({ plugin: 'memo', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^↩ 자리 비운 42분 사이$/ })).toBeDefined()
  const lines = (await ui.findAll({ type: 'Text', text: /^ {2}· / })).map(n => n.text ?? '')
  expect(lines).toEqual(['  · DHCP 220번 창2 답 기다림: 예약 이전 A·B 고르기', '  · 서약서 취합 끝남: 회신 339건 정리 끝'])

  await $.prompt.submit({ text: '왔어' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /자리 비운/ })).toBeUndefined()
  expect(JSON.parse(files.get('C:\\home\\.claude\\mods\\memo-live\\S1.json')!).typed).toBeGreaterThan(now - min)
})
