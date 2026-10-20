import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, SessionMessage, SessionRateLimit } from 'claude-code'

import type { Brief, Decision, DeskRow, Flow, Live, Memo, Meter, Tab } from '../types'

// 메뉴판: [메모: 전역 | 세션] │ [세션 현황] │ [흐름]. 칸을 누르면 메뉴판 아래에 그 목록이 펼쳐진다
// 기한 칸·선택지 칸은 2026-10-12에 뺐다(사용자: 어느 세션이 묻는지 모르겠고 쓸모없음). 기한 메모는 전역 칸 맨 위에 D-day로,
// 세션마다 기다리는 답은 세션 칸 줄 끝에 흐름 요약으로 저절로 보인다
// 메뉴판 아래 줄: 칸이 닫혀 있으면 이 세션의 목표·지금(where-am-i 방식)
// 세션 메모는 적은 세션에서만(session id는 resume해도 같다), 전역·기한 메모는 모든 세션의 전역 칸에서 보인다
const memos = atom({ plugin: 'memo', key: 'list' } as const, [] as Memo[])
const globals = atom({ plugin: 'memo', key: 'globals' } as const, [] as Memo[])
const dues = atom({ plugin: 'memo', key: 'dues' } as const, [] as Memo[])
const done = atom({ plugin: 'memo', key: 'done' } as const, [] as Memo[])
const tab = atom({ plugin: 'memo', key: 'tab' } as const, '' as Tab)
const desk = atom({ plugin: 'memo', key: 'desk' } as const, null as DeskRow[] | null)
// 세션 칸 아래 '최근 끝낸 세션' 펼침 여부
const showEnded = atom({ plugin: 'memo', key: 'showEnded' } as const, false)
// 세션 칸 [더 보기]: 꺼진 세션을 24시간이 아니라 MORE_HOURS까지 거슬러 보여 준다(주말 끼고 찾을 때)
const moreDesk = atom({ plugin: 'memo', key: 'moreDesk' } as const, false)
// 흐름 칸: 저장된 요약과 그 위에 띄울 한 줄 안내('요약 중…', 실패 이유, 그 뒤 새 대화 수)
const flow = atom({ plugin: 'memo', key: 'flow' } as const, null as Flow | null)
const flowNote = atom({ plugin: 'memo', key: 'flowNote' } as const, '')
// 다른 세션들의 상태(답 기다림 표시)
const peers = atom({ plugin: 'memo', key: 'peers' } as const, [] as Live[])
// 흐름 칸 아래 '내 질문': 이 세션에서 사용자가 보낸 말(오래된 것부터)
const asked = atom({ plugin: 'memo', key: 'asked' } as const, [] as string[])
const showAsked = atom({ plugin: 'memo', key: 'showAsked' } as const, false)
// 결정 카드 [왜? 앞뒤]: 앞 흐름·고르면 생기는 일·추천 이유까지 펼침
const whyOpen = atom({ plugin: 'memo', key: 'whyOpen' } as const, false)
const brief = atom({ plugin: 'memo', key: 'brief' } as const, null as Brief | null)
const KEEP_DONE = 3
// 상태 파일이 이만큼 안 바뀌면(1분마다 다시 쓴다) 꺼진 세션으로 본다
const LIVE_STALE = 3 * 60_000
// 어느 탭에서도 이만큼 아무것도 안 보내면 자리 비운 것으로 보고 돌아오면 브리핑을 띄운다
const AWAY = 15 * 60_000
const ASKED_SHORT = 5
const ASKED_LONG = 15
// 파일의 해결 목록은 모든 세션 것을 합쳐 최근 50개만
const KEEP_DONE_FILE = 50
// 세션 현황은 읽는 데 3~8초 걸려서 5분마다, 그리고 칸을 열 때만 새로 읽는다
const DESK_EVERY = 5 * 60_000
const MORE_HOURS = 72
// 세션 칸은 한 줄 모양 그대로 열 위치만 맞춘다(2026-10-13 사용자: 행·열이 제각각, 머리줄 있는 표는 불편).
// 버튼은 터미널에서 [ 글자 ]로 그려져 글자 칸+4: [끝][킵·풀기][열기] 자리를 늘 같은 폭으로 비워 둬 글이 같은 칸에서 시작한다
const BTN = { end: 6, keep: 8, open: 8 } as const
// 결정 카드 [왜? 앞뒤] 자리(글자 8칸+4). 둘째 결정부터는 비워 둬 ❓가 같은 칸에서 시작한다
const WHY_W = 12
const NAME_MAX = 28
// 화면 칸 수: 한글·한자·넓은 기호(⏳)는 두 칸, 나머지는 한 칸
const wide = (c: number) =>
  (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
  (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c === 0x23f3 || c >= 0x1f300
const cellsOf = (t: string) => [...t].reduce((n, ch) => n + (wide(ch.codePointAt(0)!) ? 2 : 1), 0)
// w칸에 맞춘다: 길면 잘라 …, 짧으면 띄어쓰기로 채움
const fit = (t: string, w: number) => {
  if (cellsOf(t) <= w) return t + ' '.repeat(w - cellsOf(t))
  let out = ''
  for (const ch of t) {
    if (cellsOf(out + ch) > w - 1) break
    out += ch
  }
  return fit(`${out}…`, w)
}

type Data = { list: Memo[]; done: Memo[] }
type View = { list: Memo[]; globals: Memo[]; dues: Memo[]; done: Memo[] }

const pad = (n: number) => String(n).padStart(2, '0')
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 오늘 기준 남은 날: D-3, D-day, D+2(지남)
const dday = (due: string) => {
  const [y, m, d] = due.split('-').map(Number)
  const t = new Date()
  const n = Math.round((Date.UTC(y!, m! - 1, d!) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86_400_000)
  return n === 0 ? 'D-day' : n > 0 ? `D-${n}` : `D+${-n}`
}

// "10-13", "10/13", "2026-10-13" → "2026-10-13". 연도가 없으면 올해
const dueOf = (s: string) => {
  const m = s.match(/^(?:(\d{4})[-./])?(\d{1,2})[-./](\d{1,2})$/)
  return m ? `${m[1] ?? new Date().getFullYear()}-${pad(Number(m[2]))}-${pad(Number(m[3]))}` : undefined
}

const home = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

// 원본은 JSON 파일 하나: 열린 세션 모두가 같이 읽고 쓴다
const file = async ($: EngineInterface) => `${await home($)}/.claude/mods/memo-data.json`

// 파일이 없으면 빈 목록. 깨진 파일은 throw해서 아무것도 덮어쓰지 않는다
const load = async ($: EngineInterface): Promise<Data> => {
  const path = await file($)
  if (!(await $.fs.exists(path))) return { list: [], done: [] }
  const data = JSON.parse(await $.fs.read(path)) as Partial<Data>
  return { list: data.list ?? [], done: data.done ?? [] }
}

// /clear는 session.start 없이 id를 바꾸니 매번 새로 묻는다
const mine = async ($: EngineInterface, data: Data): Promise<View> => {
  const sid = await $.session.id()
  return {
    list: data.list.filter(m => !m.global && !m.due && m.session === sid),
    globals: data.list.filter(m => m.global && !m.due),
    dues: data.list.filter(m => m.due).sort((a, b) => a.due!.localeCompare(b.due!)),
    done: data.done.filter(m => m.global || m.due || m.session === sid).slice(0, KEEP_DONE * 3),
  }
}

const view = async ($: EngineInterface) => mine($, await load($))

const show = async ($: EngineInterface, data: Data) => {
  const own = await mine($, data)
  await update($, memos, () => own.list)
  await update($, globals, () => own.globals)
  await update($, dues, () => own.dues)
  await update($, done, () => own.done)
  return own
}

// 바꿀 때마다 파일을 새로 읽어 고친다: 그사이 다른 세션이 쓴 것을 지우지 않는다
const change = async ($: EngineInterface, fn: (data: Data) => Data) => {
  const data = fn(await load($))
  await $.fs.write(await file($), JSON.stringify(data, null, 2))
  return show($, data)
}

const add = async ($: EngineInterface, text: string, extra: Pick<Memo, 'global' | 'due'>) => {
  const session = await $.session.id()
  return change($, d => ({
    ...d,
    list: [...d.list, { id: Math.max(Date.now(), ...d.list.map(m => m.id + 1)), text, at: today(), session, ...extra }],
  }))
}

const resolve = ($: EngineInterface, id: number) =>
  change($, d => {
    const memo = d.list.find(m => m.id === id)
    return memo ? { list: d.list.filter(m => m.id !== id), done: [memo, ...d.done].slice(0, KEEP_DONE_FILE) } : d
  })

// 번호 "2"는 이 세션 2번, "전2"는 전역 2번, "기2"는 기한 2번
const pick = (v: View, key: string) => {
  const hit = key.replace(/\s/g, '').match(/^(전|기)?(\d+)$/)
  if (!hit) return undefined
  return (hit[1] === '전' ? v.globals : hit[1] === '기' ? v.dues : v.list)[Number(hit[2]) - 1]
}

const lines = (v: View) => [
  ...v.list.map((m, i) => `${i + 1}. ${m.text} (${m.at})`),
  ...v.globals.map((m, i) => `전${i + 1}. ${m.text} (${m.at})`),
  ...v.dues.map((m, i) => `기${i + 1}. ${dday(m.due!)} ${m.due!.slice(5)} ${m.text}`),
]

const counts = (v: View) => `이 세션 ${v.list.length}건·전역 ${v.globals.length}건·기한 ${v.dues.length}건`

const kindOf = (extra: Pick<Memo, 'global' | 'due'>) => (extra.due ? `기한(${extra.due})` : extra.global ? '전역' : '이 세션')

// 이 PC 원본(~/.claude 아래)이 있으면 그것을, 없으면(GitHub로 설치한 다른 PC) mod에 함께 담긴 scripts/ 사본을 쓴다.
// Python은 3.12 기본 설치 자리, 없으면 py 런처
const python = async ($: EngineInterface, script: string, ...args: string[]) => {
  const h = await home($)
  const own = `${h}\\.claude\\${script}`
  const file = (await $.fs.exists(own)) ? own : `${$.plugin.root}\\scripts\\${script.split('\\').pop()}`
  const exe = `${h}\\AppData\\Local\\Programs\\Python\\Python312\\python.exe`
  return $.process.run([...((await $.fs.exists(exe)) ? [exe] : ['py', '-3']), file, ...args], {
    env: { PYTHONUTF8: '1' },
    timeoutMs: 60_000,
  })
}

const refreshDesk = async ($: EngineInterface) => {
  const more = await read($, moreDesk)
  // $를 넘기는 호출에는 펼침(...) 인자를 쓸 수 없어 둘로 나눈다(모듈이 아예 안 불러와짐)
  const { exitCode, stdout } = more ? await python($, 'mods\\desk_json.py', String(MORE_HOURS)) : await python($, 'mods\\desk_json.py')
  if (exitCode !== 0) return
  const sid = await $.session.id()
  await update($, desk, () => (JSON.parse(stdout) as DeskRow[]).map(r => ({ ...r, me: r.id === sid })))
  await attachDoing($)
}

// [새로고침]: 5분 주기를 기다리지 않고 지금 다시 읽는다. 읽는 동안은 '불러오는 중…', 실패하면 원래 목록으로 되돌린다
const reloadDesk = async ($: EngineInterface) => {
  const before = await read($, desk)
  await update($, desk, () => null)
  await refreshDesk($).catch(() => undefined)
  if ((await read($, desk)) === null) await update($, desk, () => before)
}

// 없거나 깨진 파일은 undefined: 상태·흐름·받은 답처럼 다시 만들면 되는 파일에만 쓴다
const readJson = async <T,>($: EngineInterface, path: string): Promise<T | undefined> => {
  if (!(await $.fs.exists(path))) return undefined
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

// 흐름: 이 세션을 처음부터 지금까지 목표·흐름·지금·기다림·다음으로 요약한다.
// 기본 /recap은 마지막 부분만 떼어 보여 줘 흐름을 몰랐다(2026-10-12). 처음엔 [흐름]을 눌렀을 때만 만들다가,
// 같은 날 where-am-i 방식(답이 끝날 때마다 이전 요약 + 이번 대화만 보고 고침)을 더했다.
// 세션마다 파일 하나(mods/memo-flow/<id>.json): 여러 세션이 동시에 답을 끝내도 서로 덮지 않는다. 그 전 memo-flow.json은 읽기만 한다
const flowPath = async ($: EngineInterface, sid: string) => `${await home($)}/.claude/mods/memo-flow/${sid}.json`

const loadFlow = async ($: EngineInterface, sid: string) =>
  (await readJson<Flow>($, await flowPath($, sid))) ??
  (await readJson<Record<string, Flow>>($, `${await home($)}/.claude/mods/memo-flow.json`))?.[sid] ??
  null

const messages = async ($: EngineInterface): Promise<readonly SessionMessage[]> => {
  const all = await $.session.messages()
  return Array.isArray(all) ? all : []
}

// 사용자가 보낸 말만: 시스템이 끼워 넣은 글(<…>)·끊음 표시·도구 결과는 뺀다
const promptsOf = (msgs: readonly SessionMessage[]) =>
  msgs
    .filter(m => m.role === 'user' && m.text.trim() && !/^\s*(<|\[Request interrupted)/.test(m.text))
    .map(m => m.text.trim())

const showFlow = async ($: EngineInterface) => {
  const mine = await loadFlow($, await $.session.id())
  await update($, flow, () => mine)
  await update($, flowNote, () => '')
  await update($, asked, () => [])
}

// 요약 재료: 사람이 쓴 말과 AI 답의 글만, 한 줄 300자. 길면 앞(처음 목표) 6천 자 + 뒤 3만 자
const digest = (msgs: readonly SessionMessage[]) => {
  const all = msgs
    .filter(m => m.text.trim() && !(m.role === 'user' && m.text.trimStart().startsWith('<')))
    .map(m => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n')
  return all.length <= 36_000 ? all : `${all.slice(0, 6_000)}\n…(중간 생략)…\n${all.slice(-30_000)}`
}

// 결정 카드 재료: 흐름 요약과 같은 Haiku 호출에서 함께 뽑는다(호출을 더 하지 않는다)
const DECISIONS_SHAPE = `[{"ask": "고를 것(30자 이내)", "why": "왜 지금 이 결정이 나왔는지: 앞에서 무엇을 하다 생긴 일인지(60자 이내)",
   "options": [{"key": "A나 1처럼 AI가 쓴 선택지 이름", "label": "그 선택지의 뜻(25자 이내)", "then": "고르면 다음에 생기는 일(45자 이내)"}],
   "pick": "AI가 추천한 key(없으면 빈 문자열)", "reason": "추천 이유(45자 이내, 없으면 빈 문자열)"}]`
const DECISIONS_RULE =
  // 10-20: "결정 1. ~ 추천해요"처럼 A·B 없이 추천만 쓴 답에서 []가 나와 카드가 안 떴다
  'decisions에는 마지막 AI 답이 사용자에게 고르거나 정하라고 묻는 것만 최대 3개 넣는다(번호 붙은 결정 하나가 하나). ' +
  '선택지 이름(A·B·1·2) 없이 추천안만 있으면 options를 [{"key": "ㅇㅋ", "label": 추천안}, {"key": "아니", "label": 그 반대}]로 만들고 pick은 "ㅇㅋ". ' +
  '선택지도 추천도 없는 질문·확인 부탁·할 일 안내는 넣지 않는다. 고를 게 없으면 [].'

const FLOW_SYSTEM =
  "너는 사용자가 여러 AI 세션을 오가다 '이 세션에서 뭘 하던 중이었지?'를 잊었을 때 보는 흐름 요약을 쓴다. 사용자는 비개발자다. 쉬운 한국어로 쓰고 기술 용어는 그대로 둔다."
const FLOW_ASK = `아래는 한 Claude Code 세션의 처음부터 지금까지 대화다. 마지막 부분만이 아니라 전체 흐름을 요약해 JSON 하나만 출력한다.
{"goal": "이 세션의 큰 목표 한 줄(40자 이내)",
 "steps": ["처음부터 지금까지 거쳐 온 주요 단계 3~6개, 오래된 것부터, 각 35자 이내"],
 "now": "지금 멈춘 곳 한 줄(50자 이내)",
 "waiting": "AI가 사용자에게 기다리는 답이나 행동 한 줄(50자 이내, 없으면 빈 문자열)",
 "next": "그다음 할 일 한 줄(50자 이내, 없으면 빈 문자열)",
 "decisions": ${DECISIONS_SHAPE}}
파일 경로·세션 id·코드 이름은 빼고, 무엇을 위해 무엇을 했는지 쓴다.
${DECISIONS_RULE}`
const FLOW_STEP = `아래는 한 Claude Code 세션의 이전 흐름 요약과 방금 끝난 대화 하나다. 이전 요약을 고쳐 같은 모양의 JSON 하나만 출력한다.
- goal: 목표가 분명히 바뀐 게 아니면 그대로 둔다.
- steps: 이전 단계는 그대로 두고, 이번 대화로 새 단계에 들어섰을 때만 맨 끝에 하나 더한다. 6개가 넘으면 오래된 둘을 하나로 합친다.
- now·waiting·next: 방금 대화 기준으로 새로 쓴다. waiting은 AI가 사용자에게 기다리는 답이나 행동(없으면 빈 문자열).
- decisions: 방금 AI 답 기준으로 새로 쓴다. 모양: ${DECISIONS_SHAPE}
파일 경로·세션 id·코드 이름은 빼고 쉬운 한국어로 쓴다.
${DECISIONS_RULE}`

const stamp = () => {
  const d = new Date()
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 글자 수 상한: 모델이 길이 지시를 넘겨도 저장본은 짧게. 2026-10-20 단계 하나가 270자까지 불어나
// 다음 고치기 답이 토큰 한도에서 잘려(JSON 깨짐) 10:51부터 흐름이 멈췄다
const clip = (v: unknown, n: number) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

// 요약에 반영한 답 표시(Flow.of): 답 끝 40자
const tail = (t: string) => t.replace(/\s+/g, ' ').trim().slice(-40)

// 결정 카드: 고를 것과 선택지가 둘 다 있는 것만, 최대 3개. 모양이 이상한 항목은 버린다
const decisionsOf = (v: unknown): Decision[] =>
  (Array.isArray(v) ? v : []).slice(0, 3).flatMap(raw => {
    const d = (raw ?? {}) as Record<string, unknown>
    const options = (Array.isArray(d.options) ? d.options : [])
      .map(o => (o ?? {}) as Record<string, unknown>)
      .map(o => ({ key: clip(o.key, 8), label: clip(o.label, 30), then: clip(o.then, 60) }))
      .filter(o => o.key)
      .slice(0, 5)
    return d.ask && options.length ? [{ ask: clip(d.ask, 40), why: clip(d.why, 80), options, pick: clip(d.pick, 8), reason: clip(d.reason, 60) }] : []
  })

// 모델 답에서 JSON을 꺼낸다. 목표와 단계 목록이 없으면 실패
const parseFlow = (text: string, count: number): Flow | undefined => {
  try {
    const got = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '') as Partial<Flow>
    if (!got.goal || !Array.isArray(got.steps)) return undefined
    const steps = got.steps.map(s => clip(s, 50))
    return {
      at: stamp(),
      count,
      goal: clip(got.goal, 50),
      // 6개가 넘으면 첫 단계(어디서 시작했는지)와 최근 5개
      steps: steps.length <= 6 ? steps : [steps[0]!, ...steps.slice(-5)],
      now: clip(got.now, 80),
      waiting: clip(got.waiting, 80),
      next: clip(got.next, 80),
      decisions: decisionsOf(got.decisions),
    }
  } catch {
    return undefined
  }
}

// 요약 중에 이 탭의 세션이 바뀌었으면(/clear 등) 버린다: 다른 세션 흐름으로 저장하지 않는다
const saveFlow = async ($: EngineInterface, sid: string, item: Flow) => {
  if ((await $.session.id()) !== sid) return undefined
  await $.fs.write(await flowPath($, sid), JSON.stringify(item, null, 2))
  await update($, flow, () => item)
  return item
}

// 처음부터 전체 요약: [다시 요약]과 요약이 아직 없는 세션의 첫 자동 갱신. quiet면 안내 줄을 건드리지 않는다
const makeFlow = async ($: EngineInterface, quiet = false) => {
  const sid = await $.session.id()
  if (!quiet) await update($, flowNote, () => '요약 중… 몇 초 걸려요')
  const msgs = await messages($)
  const r = await $.model.complete({
    model: 'haiku',
    system: FLOW_SYSTEM,
    prompt: `${FLOW_ASK}\n\n<대화>\n${digest(msgs)}\n</대화>`,
    maxTokens: 1400,
  })
  const parsed = r.isAnswered ? parseFlow(r.text, msgs.length) : undefined
  const item = parsed && { ...parsed, of: tail(msgs.findLast(m => m.role === 'assistant' && m.text.trim())?.text ?? '') }
  if (!item) {
    if (!quiet) await update($, flowNote, () => (r.isAnswered ? '요약 실패: 답 형식이 이상해요. [다시 요약]' : `요약 실패: ${r.reason}. [다시 요약]`))
    return undefined
  }
  const saved = await saveFlow($, sid, item)
  if (!quiet) await update($, flowNote, () => '')
  return saved
}

// 답이 끝날 때마다: 이전 요약 + 방금 대화 하나만 Haiku에 보여 고친다(전체를 다시 읽지 않아 싸다)
const stepFlow = async ($: EngineInterface, answer: string) => {
  const sid = await $.session.id()
  const msgs = await messages($)
  const mine = promptsOf(msgs)
  await update($, asked, () => mine)
  const before = await read($, flow)
  if (!before) return makeFlow($, true)
  // 이전 요약도 잘라서 보낸다: 상한을 두기 전에 저장된 긴 요약이 다시 불어나지 않게
  const prev = { goal: clip(before.goal, 50), steps: before.steps.map(s => clip(s, 50)), now: clip(before.now, 80), waiting: clip(before.waiting, 80), next: clip(before.next, 80) }
  const r = await $.model.complete({
    model: 'haiku',
    system: FLOW_SYSTEM,
    prompt:
      `${FLOW_STEP}\n\n<이전 요약>\n${JSON.stringify(prev)}\n</이전 요약>\n\n` +
      // 고르라는 말은 보통 답 끝에 있어 긴 답은 앞 1천 자 + 끝 3천 자
      `<방금 대화>\n사용자: ${(mine[mine.length - 1] ?? '').slice(0, 1500)}\n` +
      `AI: ${answer.length <= 4000 ? answer : `${answer.slice(0, 1000)}\n…(중간 생략)…\n${answer.slice(-3000)}`}\n</방금 대화>`,
    maxTokens: 1200,
  })
  const item = r.isAnswered ? parseFlow(r.text, msgs.length) : undefined
  // 고치기 답이 깨졌으면 처음부터 다시 요약한다: 한 번 깨진 요약이 계속 멈춰 있지 않게
  if (!item) return r.isAnswered ? makeFlow($, true) : undefined
  return saveFlow($, sid, { ...item, of: tail(answer) })
}

// [흐름]을 열 때: 저장본이 없으면 만들고, 있으면 그대로 보여 주며 그 뒤 새 대화 수만 알려 준다
const openFlow = async ($: EngineInterface) => {
  const msgs = await messages($)
  await update($, asked, () => promptsOf(msgs))
  const saved = await read($, flow)
  if (!saved) return void (await makeFlow($))
  const more = msgs.length - saved.count
  await update($, flowNote, () => (more > 0 ? `그 뒤 대화 ${more}개 — [다시 요약]으로 새로 만들어요` : ''))
}

// 내 질문 → 그 자리로: 화면에 그려진 내 말 줄의 id를 기억했다가 그 줄로 스크롤한다(prompt-rail 방식).
// 모듈 안 기억이라 hot reload 뒤엔 그 줄이 다시 그려져야 이동된다
const drawn = new Map<string, string>()
const rowKey = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200)

const jump = async ($: EngineInterface, text: string) => {
  const id = drawn.get(rowKey(text))
  const r: { deny?: string } = id ? await $.ui.scroll({ to: { requestId: id }, block: 'start' }) : { deny: '아직 화면에 그려지지 않은 말이에요' }
  if (!r.deny) return
  $.ui.toast(/not scrollable/.test(r.deny) ? '이 화면에서는 대화 이동이 막혀 있어요' : `그 자리로 못 감: ${r.deny}`)
}

// 세션 상태판: 이 세션 파일만 쓴다. 다른 세션은 1분마다 다시 써지는지로 살아 있는지 본다
const liveDir = async ($: EngineInterface) => `${await home($)}/.claude/mods/memo-live`

// -p 실행(화면 없음)은 상태판에 올리지 않고 흐름도 만들지 않는다
const shown = async ($: EngineInterface) => (await $.session.surfaces()).length > 0

const setLive = async ($: EngineInterface, state: Live['state'], why = '') => {
  if (!(await shown($))) return
  const sid = await $.session.id()
  const path = `${await liveDir($)}/${sid}.json`
  const before = await readJson<Live>($, path)
  const since = before && before.state === state && before.why === why ? before.since : Date.now()
  // 다른 세션에 보일 이름: 세션 칸 이름 → 흐름 목표 → 세션 id 앞자리
  const fl = await read($, flow)
  const name = (await read($, desk))?.find(r => r.id === sid)?.name ?? fl?.goal ?? sid.slice(0, 8)
  // 답하는 중으로 바뀌는 순간 = 사용자가 뭔가 보낸 때(말 보내기·질문 창 답)
  const typed = state === 'working' && before?.state !== 'working' ? Date.now() : before?.typed
  await $.fs.write(path, JSON.stringify({ id: sid, state, why, since, name, at: fl?.at, typed, doing: clip(fl?.waiting || fl?.now, 60) }))
}

const beat = async ($: EngineInterface) => {
  const now = await readJson<Live>($, `${await liveDir($)}/${await $.session.id()}.json`)
  await setLive($, now && now.state !== 'off' ? now.state : 'idle', now?.why ?? '')
}

// 세션 칸 줄마다 그 세션이 하던 일: 흐름 요약의 기다리는 답, 없으면 지금. 요약이 없는 세션(Codex 등)은 마지막 요청.
// 그사이 [끝]·[킵]으로 바뀐 줄을 덮지 않게 '하던 일'만 끼워 넣는다
const attachDoing = async ($: EngineInterface) => {
  const rows = await read($, desk)
  if (!rows) return
  const old = (await readJson<Record<string, Flow>>($, `${await home($)}/.claude/mods/memo-flow.json`)) ?? {}
  const doing = new Map<string, string>()
  for (const r of rows) {
    const f = (await readJson<Flow>($, await flowPath($, r.id))) ?? old[r.id]
    doing.set(r.id, (f ? f.waiting || f.now : r.last_user ? `마지막 요청: ${r.last_user}` : '').replace(/\s+/g, ' ').trim())
  }
  await update($, desk, cur => cur && cur.map(r => ({ ...r, doing: doing.get(r.id) ?? r.doing })))
}

// 답이 끝나면 일단 '할 일 없음'으로 두고, 흐름 요약이 기다리는 답을 찾으면 '답 기다림'으로 바꾼다.
// 그사이 사용자가 다음 말을 보냈으면(작업 중) 덮지 않는다
const afterTurn = async ($: EngineInterface, answer: string) => {
  if (!(await shown($))) return
  await setLive($, 'idle')
  if (!answer.trim()) return
  const item = await stepFlow($, answer)
  const now = await readJson<Live>($, `${await liveDir($)}/${await $.session.id()}.json`)
  if (now?.state !== 'idle') return
  await setLive($, item?.waiting ? 'waiting' : 'idle', item?.waiting ?? '')
}

// 코드를 고쳐 다시 불러오면 답이 끝나는 순간 돌던 흐름 갱신이 끊긴다(엔진이 기다리던 Haiku 호출을 버림, 10-20 결정 카드가 안 뜬 원인).
// 다시 불러오면 session.start가 오니 그때 마지막 답이 요약에 없으면 이어서 고친다. 도구를 쓰는 중인 답(작업 중)은 건드리지 않는다
const catchUpFlow = async ($: EngineInterface) => {
  const last = (await messages($)).at(-1)
  if (last?.role !== 'assistant' || last.toolUses.length || !last.text.trim()) return
  if ((await read($, flow))?.of !== tail(last.text)) await afterTurn($, last.text)
}

// 다른 세션 상태: 파일 시각이 바뀐 것만 다시 읽는다. 세션 칸 줄의 '⏳ 답 기다림'에만 쓴다(메뉴판 ⏳ 줄·알림은 2026-10-13 사용자 요청으로 뺌)
const liveCache = new Map<string, { at: number; live?: Live }>()

// 돌아오면 3줄 브리핑(10-20 사용자 요청): 어느 탭에서도 AWAY 넘게 아무것도 안 보냈으면, 그사이 답 기다림·끝남으로 바뀐 다른 탭을 3개까지.
// 흐름 칸은 이 탭 하나의 이야기, 이건 비운 사이 다른 탭 전부. 탭마다 있는 흐름 요약(Live.doing)을 써서 모델을 부르지 않는다. 어느 탭에서든 말을 보내면 사라진다
const briefOf = (mine: Live | undefined, list: Live[], now: number): Brief | null => {
  const last = Math.max(mine?.typed ?? 0, ...list.map(l => l.typed ?? 0))
  if (!last || now - last < AWAY) return null
  const items = list
    .filter(l => l.since > last && l.state !== 'working')
    .sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || b.since - a.since)
    .slice(0, 3)
  return items.length ? { mins: Math.floor((now - last) / 60_000), items } : null
}
const showPeers = async ($: EngineInterface) => {
  const dir = await liveDir($)
  const sid = await $.session.id()
  const now = Date.now()
  const list: Live[] = []
  let self: Live | undefined
  for (const f of await $.fs.list(dir).catch(() => [])) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || now - f.mtimeMs > LIVE_STALE) continue
    const hit = liveCache.get(f.name)
    const live = hit && hit.at === f.mtimeMs ? hit.live : await readJson<Live>($, `${dir}/${f.name}`)
    liveCache.set(f.name, { at: f.mtimeMs, live })
    if (f.name === `${sid}.json`) self = live
    else if (live && live.state !== 'off') list.push(live)
  }
  const b = briefOf(self, list, now)
  if (JSON.stringify(b) !== JSON.stringify(await read($, brief))) await update($, brief, () => b)
  const before = await read($, peers)
  if (JSON.stringify(before) === JSON.stringify(list)) return
  await update($, peers, () => list)
  void attachDoing($).catch(() => undefined)
}

// 사용량 줄(2026-10-19 사용자: statusline이 이상해 mod로 바꿈, statusline은 끔). 메뉴판 맨 아래 = 입력창 바로 위 한 줄:
// 5h·주 한도 → 대화칸 → 모델·effort → 세션 앞 8자리(계정은 로그인 토큰 파일을 열어야 해 10-20 뺐다). 좁으면 뒤부터 잘려 한도는 끝까지 남는다
const meter = atom({ plugin: 'memo', key: 'meter' } as const, null as Meter | null)
// 1분마다 올려 남은 시간을 다시 그린다
const minute = atom({ plugin: 'memo', key: 'minute' } as const, 0)
const WARN_AT = 90
const CAUTION_AT = 75
const LIMIT_ORDER = ['five_hour', 'seven_day']
const LIMIT_NAME: Record<string, string> = { five_hour: '5h', seven_day: '주' }
const EMPTY_METER: Meter = { limits: [], model: '', effort: '' }

const setMeter = ($: EngineInterface, part: Partial<Meter>) => update($, meter, m => ({ ...(m ?? EMPTY_METER), ...part }))

// 5칸 막대: 한 칸 20%, 반 칸은 ▌
const bar = (p: number) => {
  const n = Math.round(Math.min(100, Math.max(0, p)) / 10)
  return `${'█'.repeat(n >> 1)}${n & 1 ? '▌' : ''}${'░'.repeat(5 - (n >> 1) - (n & 1))}`
}

// 초기화까지 남은 시간: 40m, 1h05, 2d3h. 지났거나 모르면 ''
const left = (iso?: string) => {
  const m = iso ? Math.floor((Date.parse(iso) - Date.now()) / 60_000) : NaN
  if (!(m >= 0)) return ''
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${pad(m % 60)}` : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`
}

// claude-opus-5-5 → Opus 5.5. 모르는 모양은 그대로
const modelName = (id: string) => {
  const h = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i)
  return h ? `${h[1]![0]!.toUpperCase()}${h[1]!.slice(1)} ${h[2]}${h[3] ? `.${h[3]}` : ''}` : id
}

// 세션을 열 때: effort는 첫 턴 전까지 설정값, 그 뒤엔 턴마다 실제로 보낸 값(turn.step)
const startMeter = async ($: EngineInterface) => {
  const u = await $.session.usage()
  const { effortLevel } = (await $.settings.read()) as { effortLevel?: unknown }
  await setMeter($, {
    limits: u.rateLimits,
    ctx: u.context.percent,
    model: await $.session.model(),
    effort: effortLevel ? String(effortLevel) : '',
  })
}

// 90%를 넘으면 한도마다 한 번 알린다. 90% 아래로 내려가면(초기화) 다시 알릴 수 있다. 탭마다 따로 뜬다
const warned = new Set<string>()
const warnLimits = ($: EngineInterface, limits: readonly SessionRateLimit[]) => {
  for (const l of limits) {
    if (l.percentUsed < WARN_AT) warned.delete(l.kind)
    else if (!warned.has(l.kind)) {
      warned.add(l.kind)
      const t = left(l.resetsAt)
      $.ui.toast(`${LIMIT_NAME[l.kind] ?? l.kind} 한도 ${Math.round(l.percentUsed)}%${t ? ` — ${t} 뒤 초기화` : ''}`)
    }
  }
}

// 사용량 줄 조각: 한도는 75% 노랑·90% 빨강, 남은 시간은 5h는 늘·주는 75%부터. 나머지는 흐리게
type Piece = { text: string; color?: 'warning' | 'error'; dim?: boolean }
const rank = (kind: string) => LIMIT_ORDER.indexOf(kind) + 1 || 9
const meterPieces = (m: Meter, sid: string): Piece[] => {
  const limits = m.limits.filter(l => Number.isFinite(l.percentUsed)).sort((a, b) => rank(a.kind) - rank(b.kind))
  const segs: Piece[][] = limits.map(l => {
    const p = l.percentUsed
    const t = l.kind === 'five_hour' || p >= CAUTION_AT ? left(l.resetsAt) : ''
    const color = p >= WARN_AT ? ('error' as const) : p >= CAUTION_AT ? ('warning' as const) : undefined
    return [{ text: `${LIMIT_NAME[l.kind] ?? l.kind} ${bar(p)} ${Math.round(p)}%`, color }, ...(t ? [{ text: ` · ${t} 남음`, dim: true }] : [])]
  })
  const rest = [m.ctx === undefined ? '' : `대화칸 ${m.ctx}%`, `${modelName(m.model)} ${m.effort.toUpperCase()}`.trim(), sid.slice(0, 8)]
  for (const t of rest) if (t) segs.push([{ text: t, dim: true }])
  return segs.flatMap((s, i) => (i ? [{ text: ' · ', dim: true }, ...s] : s))
}

// [끝]: /done과 같은 끝남 표시. 숨김 기록(done.json)은 recent_sessions.py 하나만 쓴다
const endSession = async ($: EngineInterface, row: DeskRow) => {
  const { exitCode, stdout } = await python($, 'scripts\\recent_sessions.py', '--done', row.id)
  if (exitCode !== 0 || !stdout.includes('끝남으로 표시')) {
    $.ui.toast(`숨기지 못함: ${row.name}`)
    return
  }
  await update($, desk, rows => {
    const rest = (rows ?? []).filter(r => r.id !== row.id)
    const at = rest.findIndex(r => r.done)
    return [...rest.slice(0, at < 0 ? rest.length : at), { ...row, done: true }, ...rest.slice(at < 0 ? rest.length : at)]
  })
  $.ui.toast(`숨김: ${row.name}${row.me ? ' — 이제 이 탭을 닫아도 됩니다' : ''} · 되살리기는 /done 해제 ${row.id.slice(0, 8)}`)
}

// [되살리기]: 끝남 표시를 풀어 목록으로 되돌린다(/done 해제와 같음)
const reviveSession = async ($: EngineInterface, row: DeskRow) => {
  const { exitCode, stdout } = await python($, 'scripts\\recent_sessions.py', '--undone', row.id)
  if (exitCode !== 0 || !stdout.includes('끝남 표시 해제')) {
    $.ui.toast(`되살리지 못함: ${row.name}`)
    return
  }
  await update($, desk, rows => (rows ?? []).map(r => (r.id === row.id ? { ...r, done: false } : r)))
}

// [열기]: 꺼진 세션을 새 명령 프롬프트 탭으로 다시 연다(킵이어도). 여는 일은 복구 데스크와 같은 recent_sessions.py가 한다(이미 열린 세션은 건너뜀).
// 누르고 탭이 뜨기 전 또 누르면 두 번 열리니 20초는 같은 줄을 다시 받지 않고, 15초 뒤 세션 칸을 다시 읽어 ● 실행 중으로 바꾼다
const opening = new Set<string>()
const openSession = async ($: EngineInterface, row: DeskRow) => {
  if (opening.has(row.id)) return
  opening.add(row.id)
  void $.clock.after(20_000, () => opening.delete(row.id))
  const { exitCode, stdout } = await python($, 'scripts\\recent_sessions.py', '--open-id', row.id)
  if (exitCode === 0 && stdout.includes('이미 열려 있어')) $.ui.toast(`이미 열려 있어요: ${row.name}`)
  else if (exitCode === 0 && stdout.includes('열었습니다')) $.ui.toast(`새 탭으로 여는 중: ${row.name}`)
  else $.ui.toast(`열지 못함: ${row.name}`)
  void $.clock.after(15_000, () => refreshDesk($).catch(() => undefined))
}

// [킵]/[풀기]: 급하지 않아 나중에 할 세션 표시. 기록(keep.json)도 recent_sessions.py 하나만 쓴다
const keepSession = async ($: EngineInterface, row: DeskRow) => {
  const { exitCode, stdout } = await python($, 'scripts\\recent_sessions.py', row.kept ? '--unkeep' : '--keep', row.id)
  if (exitCode !== 0 || !stdout.includes(row.kept ? '킵 표시 해제' : '킵으로 표시')) {
    $.ui.toast(`킵 표시를 못 바꿈: ${row.name}`)
    return
  }
  await update($, desk, rows => (rows ?? []).map(r => (r.id === row.id ? { ...r, kept: !row.kept } : r)))
}

const HINT: Record<'global' | 'session', string> = {
  session: '"○○ 메모해"라고 하면 들어옵니다',
  global: '"전역으로 ○○ 메모해"라고 하면 들어옵니다 · "10월 13일까지 ○○ 메모해"는 맨 위에 D-day로',
}

const TABS: Tab[] = ['global', 'session', 'desk', 'flow']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'memo',
      description:
        '메모: /memo 내용 = 이 세션, /memo 전역 내용 = 모든 세션, /memo 기한 10-13 내용 = 기한, /memo = 펼쳐 보기, /memo done 번호(전1·기1) = 해결',
    })
    await $.tool.register({
      name: 'add',
      description:
        '사용자의 할 일 메모에 한 줄을 추가한다. 사용자가 "메모해", "적어둬", "챙겨둬"처럼 명시적으로 요청할 때만 쓴다. 기본은 이 세션 메모(이 세션에서만 보임). 사용자가 "전역 메모해", "전체 메모해", "모든 세션에"처럼 말하면 scope "global"(모든 Claude·Codex 세션에서 보임). "10월 13일까지"처럼 날짜까지 할 일이면 due에 YYYY-MM-DD를 넣는다(기한 메모, 모든 세션 전역 칸 맨 위에 D-day로 보임). text는 나중에 봐도 알 수 있게 한 문장으로 쓰고 날짜는 빼도 된다.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          scope: { type: 'string', enum: ['session', 'global'] },
          due: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'done',
      description:
        '사용자의 할 일 메모 하나를 해결 처리한다. 체크는 사용자 몫이다: 사용자가 그 메모를 해결 처리하라고 직접 명령했거나, 해결 처리할지 물어 사용자가 그러라고 답했을 때만 쓴다. 일을 끝냈다는 이유만으로 스스로 쓰지 않는다. match는 이 세션 메모 번호("2"), 전역 메모 번호("전2"), 기한 메모 번호("기2"), 또는 메모 문구의 일부.',
      inputSchema: {
        type: 'object',
        properties: { match: { type: 'string' } },
        required: ['match'],
      },
    })
    await show($, await load($))

    // 다른 세션이 파일을 바꾸거나 이 탭의 세션 번호가 바뀌면 5초 안에 다시 그린다.
    // 세션이 끝나고 같은 프로세스에서 이어질 때 session.start 없이 번호가 바뀌어 '세션 0'에 멈춰 있었다(2026-10-08)
    // 5초마다 다른 세션 상태(답 기다림)도 본다
    let seen = 0
    let was = await $.session.id()
    void $.clock.every(5000, async () => {
      const sid = await $.session.id()
      const moved = sid !== was
      was = sid
      if (moved) {
        await showFlow($)
        void refreshDesk($).catch(() => undefined)
      }
      await showPeers($).catch(() => undefined)
      const stat = await $.fs.stat(await file($)).catch(() => undefined)
      if ((!stat || stat.mtimeMs === seen) && !moved) return
      seen = stat?.mtimeMs ?? seen
      await show($, await load($))
    })
    await showFlow($)
    await setLive($, 'idle').catch(() => undefined)
    void catchUpFlow($).catch(() => undefined)
    await showPeers($).catch(() => undefined)
    void $.clock.every(60_000, () => beat($).catch(() => undefined))
    void $.clock.after(2000, () => refreshDesk($).catch(() => undefined))
    void $.clock.every(DESK_EVERY, () => refreshDesk($).catch(() => undefined))
    void startMeter($).catch(() => undefined)
    void $.clock.every(60_000, () => update($, minute, n => n + 1).catch(() => undefined))

    return next(e)
  })

  // 사용량 줄: 한도·대화칸이 바뀔 때마다 엔진이 알려 준다(statusline과 같은 숫자). 90%를 넘으면 알림
  on('session.measure', async ($, e, next) => {
    // 코드를 고쳐 다시 불러온 탭은 session.start 없이 오니 여기서 처음 채운다
    if (!(await read($, meter))) await startMeter($).catch(() => undefined)
    else await setMeter($, { limits: e.rateLimits, ctx: e.context.percent }).catch(() => undefined)
    warnLimits($, e.rateLimits)
    return next(e)
  })

  // 사용량 줄의 모델·effort: 이 턴에 실제로 보내는 값(/model·/effort로 바꾼 것 포함). 서브에이전트는 빼고, 요청은 그대로 넘긴다
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) void setMeter($, { model: e.model, effort: e.effort === undefined ? '' : String(e.effort) }).catch(() => undefined)
    return yield* next(e)
  })

  // 답이 끝나면 흐름을 고치고 상태판에 '답 기다림/할 일 없음'을 적는다. 턴은 바로 끝나게 뒤에서 돈다. 서브에이전트 턴은 뺀다
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && e.reason === 'answer') void afterTurn($, e.answer).catch(() => undefined)
    else if (!e.agentId) void setLive($, 'idle').catch(() => undefined)
    return r
  })

  // 질문 창(AskUserQuestion)이 떠 있는 동안은 '답 기다림'
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId || next.origin.plugin !== 'engine') return next(e)
    await setLive($, 'waiting', '질문 창에 답해 주세요').catch(() => undefined)
    const r = await next(e)
    await setLive($, 'working').catch(() => undefined)
    return r
  })

  on('session.end', async ($, e, next) => {
    await setLive($, 'off').catch(() => undefined)
    return next(e)
  })

  // 화면에 그려진 내 말 줄의 id를 기억해 둔다(내 질문 → 그 자리로). 그리는 것은 그대로 둔다
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (!e.props.task && !e.props.from) drawn.set(rowKey(e.props.text), e.requestId)
    return next(e)
  })

  // 다음 말을 보내면 펼친 칸을 접는다: 답을 읽을 자리를 비워 둔다
  on('prompt.submit', async ($, e, next) => {
    void setLive($, 'working').catch(() => undefined)
    await update($, brief, () => null)
    if (await read($, tab)) await update($, tab, () => '')
    // 답을 보냈으면 결정 카드를 내린다. 다음 답이 끝나면 흐름 갱신이 새로 채운다
    await update($, flow, f => (f?.decisions?.length ? { ...f, decisions: [] } : f))
    await update($, whyOpen, () => false)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__memo__add' }, async ($, e) => {
    const input = e as { text?: unknown; scope?: unknown; due?: unknown }
    const text = String(input.text ?? '').trim()
    if (!text) return { deny: 'text가 비었습니다.' }
    const due = input.due ? dueOf(String(input.due)) : undefined
    if (input.due && !due) return { deny: 'due는 YYYY-MM-DD로 주세요.' }
    const extra = due ? { due } : input.scope === 'global' ? { global: true as const } : {}
    const v = await add($, text, extra)
    return { result: `${kindOf(extra)} 메모 추가함 (${counts(v)}): ${text}` }
  })

  on('tool.call', { tool: 'mcp__memo__done' }, async ($, e) => {
    const match = String((e as { match?: unknown }).match ?? '').trim()
    const v = await view($)
    const target = pick(v, match) ?? [...v.list, ...v.globals, ...v.dues].find(m => match && m.text.includes(match))
    if (!target) return { result: `"${match}"에 맞는 메모가 없습니다. 지금 미해결: ${lines(v).join(' / ') || '없음'}` }
    await resolve($, target.id)
    return { result: `해결함: ${target.text}` }
  })

  on('command.run', { command: 'memo' }, async ($, e) => {
    const args = e.args.trim()

    const hit = args.match(/^(done|해결|삭제)\s+((?:전|기)?\s*\d+)$/)
    if (hit) {
      const target = pick(await view($), hit[2]!)
      if (!target) return { text: `${hit[2]}번 메모가 없습니다.` }
      await resolve($, target.id)
      return { text: `해결함: ${target.text}` }
    }

    const dueHit = args.match(/^기한\s+(\S+)\s+(.+)$/)
    if (dueHit) {
      const due = dueOf(dueHit[1]!)
      if (!due) return { text: '날짜를 10-13이나 2026-10-13처럼 적어 주세요.' }
      const v = await add($, dueHit[2]!, { due })
      return { text: `기한(${due}) 메모 추가함 (${counts(v)})` }
    }

    const wide = args.match(/^(전역|전체)\s+(.+)$/)
    if (args) {
      const extra = wide ? { global: true as const } : {}
      const v = await add($, wide ? wide[2]! : args, extra)
      return { text: `${kindOf(extra)} 메모 추가함 (${counts(v)})` }
    }

    await update($, tab, () => 'session')
    const v = await view($)
    const all = lines(v)
    return { text: [...(all.length ? all : ['미해결 메모 없음']), ...v.done.slice(0, KEEP_DONE).map(m => `✓ ${m.text}`)].join('\n') }
  })

  // 입력창 바로 위 메뉴판(2줄). 칸을 누르면 그 아래에 목록이 펼쳐지고, 다시 누르거나 다음 말을 보내면 접힌다
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, memos)
    const global = await read($, globals)
    const due = await read($, dues)
    // 없앤 칸(기한·선택지)이 열린 채 남아 있으면 닫힌 것으로 본다
    const stored = await read($, tab)
    const open: Tab = TABS.includes(stored) ? stored : ''
    const rows = await read($, desk)
    const fl = await read($, flow)
    // 사용량 줄은 어느 칸이 열려 있든 맨 아래(입력창 바로 위)에 둔다
    const m = await read($, meter)
    await read($, minute)
    const meterRow = m && (
      <Text key="meter" wrap="truncate">
        <Text dimColor>⏱ </Text>
        {meterPieces(m, await $.session.id()).map((p, i) => (
          <Text key={`meter-${i}`} dimColor={Boolean(p.dim)} {...(p.color ? { color: p.color } : {})}>
            {p.text}
          </Text>
        ))}
      </Text>
    )
    const wrap = (top: RenderElement) => (meterRow ? <Box flexDirection="column">{top}{meterRow}</Box> : top)
    // 다른 세션 중 답을 기다리는 것: 세션 칸 줄에 쓴다
    const blocked = (await read($, peers)).filter(p => p.state === 'waiting')
    const isBlocked = (id: string) => blocked.find(p => p.id === id)

    const press = (t: Exclude<Tab, ''>) => async () => {
      const now = await update($, tab, v => (v === t ? '' : t))
      if (now === 'desk') await refreshDesk($).catch(() => undefined)
      if (now === 'flow') await openFlow($)
    }
    const button = (t: Exclude<Tab, ''>, label: string) => (
      <Button key={`tab-${t}`} label={label} variant={open === t ? 'primary' : 'secondary'} onPress={press(t)} />
    )
    const sep = () => (
      <Box flexDirection="column">
        <Text dimColor> │ </Text>
        <Text dimColor> │ </Text>
      </Box>
    )
    const active = (rows ?? []).filter(r => !r.done)
    const ended = (rows ?? []).filter(r => r.done)
    const live = active.filter(r => r.live).length

    const menu = (
      <Box>
        <Box flexDirection="column">
          <Text dimColor>메모</Text>
          <Box>
            {button('global', `전역 ${global.length + due.length}${due.length ? ` · ${dday(due[0]!.due!)}` : ''}`)}
            <Text> </Text>
            {button('session', `세션 ${list.length}`)}
          </Box>
        </Box>
        {sep()}
        <Box flexDirection="column">
          <Text dimColor>세션</Text>
          {button('desk', rows ? `● ${live}  ○ ${active.length - live}` : '보기')}
        </Box>
        {sep()}
        <Box flexDirection="column">
          <Text dimColor>흐름</Text>
          {button('flow', fl ? fl.at.slice(-5) : '보기')}
        </Box>
      </Box>
    )
    // 돌아오면 브리핑: 칸이 닫혀 있을 때 메뉴판 바로 아래
    const br = await read($, brief)
    const briefRows = br && (
      <Box key="brief" flexDirection="column">
        <Text color="claude">{`↩ 자리 비운 ${br.mins}분 사이`}</Text>
        {br.items.map(l => {
          const win = rows?.find(r => r.id === l.id)?.win
          return (
            <Text key={`brief-${l.id}`} wrap="truncate">
              {`  · ${l.name}${win ? ` 창${win}` : ''} `}
              <Text bold>{l.state === 'waiting' ? '답 기다림' : '끝남'}</Text>
              {l.doing ? <Text dimColor>{`: ${l.doing}`}</Text> : ''}
            </Text>
          )
        })}
      </Box>
    )
    if (!open) {
      if (!fl) return wrap(briefRows ? <Box flexDirection="column">{menu}{briefRows}</Box> : menu)
      // 칸이 닫혀 있으면 이 세션의 목표·지금을 늘 보인다(where-am-i 방식). 기다리는 답 줄은 사용자 요청으로 뺐다(10-14)
      // 방금 답이 고르라고 했으면 결정 카드: 한 줄에 고를 것과 선택지 뜻, [왜? 앞뒤]로 앞 흐름·고르면 생기는 일·추천 이유
      const cards = fl.decisions ?? []
      const why = await read($, whyOpen)
      const pickMark = (d: Decision, key: string) => (key === d.pick ? ' ★' : '')
      return wrap(
        <Box flexDirection="column">
          {menu}
          {briefRows}
          <Text key="strip" wrap="truncate">
            <Text color="claude" bold>
              ◆{' '}
            </Text>
            {fl.goal}
            <Text dimColor>{'  ▶ '}</Text>
            {fl.now}
          </Text>
          {cards.map((d, i) => (
            <Box key={`decide-${i}`} flexDirection="column">
              <Box>
                <Box width={WHY_W} flexShrink={0}>
                  {i === 0 && <Button key="why" label={why ? '접기' : '왜? 앞뒤'} dimColor onPress={() => update($, whyOpen, v => !v)} />}
                </Box>
                <Text wrap="truncate">
                  <Text color="claude">❓ </Text>
                  {d.ask}
                  {!why && <Text dimColor>{` — ${d.options.map(o => `${o.key} ${o.label}${pickMark(d, o.key)}`).join(' · ')}`}</Text>}
                </Text>
              </Box>
              {why && (
                <Box flexDirection="column" marginLeft={WHY_W + 3}>
                  {d.why && <Text wrap="wrap" dimColor>{`앞: ${d.why}`}</Text>}
                  {d.options.map(o => (
                    <Text key={`opt-${i}-${o.key}`} wrap="wrap">{`${o.key} ${o.label}${pickMark(d, o.key)}${o.then ? ` → ${o.then}` : ''}`}</Text>
                  ))}
                  {d.reason && <Text wrap="wrap" dimColor>{`★ 추천 이유: ${d.reason}`}</Text>}
                </Box>
              )}
            </Box>
          ))}
        </Box>,
      )
    }

    if (open === 'flow') {
      const note = await read($, flowNote)
      const said = await read($, asked)
      const long = await read($, showAsked)
      const shownAsk = said.map((text, i) => ({ text, i })).slice(-(long ? ASKED_LONG : ASKED_SHORT))
      // 왼쪽에 라벨을 고정하고 기호로 구분한다: 흐름은 번호, 지금 ▶(강조색), 다음 →. 기다림 ⏳ 줄은 10-20 사용자 요청으로 뺐다
      const row = (key: string, label: string, body: string, look: Record<string, unknown> = {}) => (
        <Box key={key}>
          <Text dimColor>{` ${label}  `}</Text>
          <Text wrap="wrap" {...look}>
            {body}
          </Text>
        </Box>
      )
      return wrap(
        <Box flexDirection="column">
          {menu}
          <Box>
            <Button key="flow-redo" label={fl ? '다시 요약' : '요약하기'} onPress={() => makeFlow($)} />
            <Text dimColor wrap="truncate">
              {fl ? ` ${fl.at} 요약` : ''}
              {note ? ` · ${note}` : ''}
            </Text>
          </Box>
          {fl && row('f-goal', '목표', fl.goal)}
          {fl && fl.steps.map((s, i) => row(`f-step${i}`, i === 0 ? '흐름' : '    ', `${i + 1}. ${s}`))}
          {fl && row('f-now', '지금', `▶ ${fl.now}`, { bold: true, color: 'claude' })}
          {fl?.next ? row('f-next', '다음', `${fl.waiting === undefined ? '? ' : '→ '}${fl.next}`, fl.waiting === undefined ? { color: 'warning' } : {}) : null}
          {said.length > 0 && (
            <Box key="asked-head">
              <Text dimColor>{` 내 질문 ${said.length}개 · 번호를 누르면 그 자리로 `}</Text>
              {said.length > ASKED_SHORT && (
                <Button
                  key="asked-more"
                  label={long ? `최근 ${ASKED_SHORT}개만` : `최근 ${Math.min(said.length, ASKED_LONG)}개`}
                  onPress={() => update($, showAsked, v => !v)}
                />
              )}
            </Box>
          )}
          {shownAsk.map(({ text, i }) => (
            <Box key={`q${i}`}>
              <Text>{' '}</Text>
              <Button key={`ask-${i}`} label={`${i + 1}`} plain onPress={() => jump($, text)} />
              <Text wrap="truncate" dimColor>
                {` ${text.replace(/\s+/g, ' ')}`}
              </Text>
            </Box>
          ))}
        </Box>,
      )
    }

    if (open === 'desk') {
      const opened = await read($, showEnded)
      const more = await read($, moreDesk)
      // 줄 모양: [끝][킵][열기] 상태 · (창N) · (지금·킵) · (Codex) · 이름 (시각) — 하던 일. 실행 중이면 시각은 빼고, 킵·꺼짐은 남긴다.
      // 칸마다 지금 보이는 줄 중 가장 긴 것에 맞춰 띄어쓰기로 채운다. 빈 칸은 구분점(·)도 띄어쓰기로 바꿔 열만 남긴다
      // 하던 일: 이 세션은 지금 흐름, 답 기다리는 세션은 그 이유, 나머지는 세션 칸을 읽을 때 붙인 흐름 요약
      const order = [
        ...active.filter(r => r.me),
        ...active.filter(r => !r.me && isBlocked(r.id)),
        ...active.filter(r => !r.me && !isBlocked(r.id) && !r.kept),
        ...active.filter(r => !r.me && !isBlocked(r.id) && r.kept),
      ]
      const partsOf = (r: DeskRow) => {
        const wait = isBlocked(r.id)
        return {
          state: r.done ? '✓ 끝냄' : r.live ? '● 실행 중' : '○ 꺼짐',
          // 창이 여럿일 때 그 탭이 있는 창(10-20 사용자 선택 A). 창 하나면 desk_json.py가 안 줘서 칸이 통째로 빠진다
          win: r.live && r.win ? `창${r.win}` : '',
          // ⏳ 답 기다림 표시는 10-20 사용자 요청으로 뺐다. 답 기다리는 세션은 그대로 위로 올리고 하던 일 칸에 묻는 내용을 보인다
          mark: [r.me ? '▶ 지금' : '', r.kept ? '⏸ 킵' : ''].filter(Boolean).join(' · '),
          tool: r.tool === 'codex' ? 'Codex' : '',
          name: r.name,
          when: !r.live || r.kept || r.done ? `(${r.last})` : '',
          doing: ((r.me && fl ? fl.waiting || fl.now : wait?.why || r.doing) ?? '').replace(/\s+/g, ' '),
        }
      }
      const shown = [...order, ...(opened ? ended : [])].map(partsOf)
      const widest = (k: 'state' | 'win' | 'mark' | 'tool' | 'name' | 'when') => Math.max(0, ...shown.map(p => cellsOf(p[k])))
      const w = { state: widest('state'), win: widest('win'), mark: widest('mark'), tool: widest('tool'), name: Math.min(NAME_MAX, widest('name')), when: widest('when') }
      const slot = (t: string, width: number) => (width === 0 ? '' : t ? `${fit(t, width)} · ` : ' '.repeat(width + 3))
      const line = (r: DeskRow) => {
        const p = partsOf(r)
        return (
          ` ${slot(p.state, w.state)}${slot(p.win, w.win)}${slot(p.mark, w.mark)}${slot(p.tool, w.tool)}${fit(p.name, w.name)}` +
          `${w.when ? ` ${fit(p.when, w.when)}` : ''}${p.doing ? ` — ${p.doing}` : ''}`
        ).trimEnd()
      }
      return wrap(
        <Box flexDirection="column">
          {menu}
          <Box>
            <Button key="desk-refresh" label="새로고침" onPress={() => reloadDesk($)} />
            <Button
              key="desk-more"
              label={more ? '하루만 ▴' : `더 보기(${MORE_HOURS / 24}일) ▾`}
              onPress={async () => {
                await update($, moreDesk, v => !v)
                await reloadDesk($)
              }}
            />
            {ended.length > 0 && (
              <Button key="desk-ended" label={`최근 끝낸 ${ended.length} ${opened ? '▴' : '▾'}`} onPress={() => update($, showEnded, v => !v)} />
            )}
            <Text dimColor wrap="truncate"> [끝] 숨김(탭 닫을 것) · [킵] 나중에(복구 때 전부 열기에서 빠짐) · [열기] 꺼진 세션 다시 열기</Text>
          </Box>
          {rows === null && <Text dimColor>불러오는 중…</Text>}
          {order.map(r => (
            <Box key={`row-${r.id}`}>
              <Box width={BTN.end} flexShrink={0}>
                <Button key={`end-${r.id}`} label="끝" dimColor onPress={() => endSession($, r)} />
              </Box>
              <Box width={BTN.keep} flexShrink={0}>
                <Button key={`keep-${r.id}`} label={r.kept ? '풀기' : '킵'} dimColor onPress={() => keepSession($, r)} />
              </Box>
              <Box width={BTN.open} flexShrink={0}>
                {!r.live && <Button key={`open-${r.id}`} label="열기" onPress={() => openSession($, r)} />}
              </Box>
              <Text
                wrap="truncate"
                dimColor={!r.me && !isBlocked(r.id) && (!r.live || r.kept)}
                // 바로 이 세션 줄은 색을 칠해 한눈에 띄게(테마 색을 따른다)
                {...(r.me ? { bold: true, color: 'inverseText', backgroundColor: 'claude' } : isBlocked(r.id) ? { color: 'warning' } : {})}
              >
                {line(r)}
              </Text>
            </Box>
          ))}
          {opened &&
            ended.map(r => (
              <Box key={`ended-${r.id}`}>
                <Box width={BTN.end + BTN.keep + BTN.open} flexShrink={0}>
                  <Button key={`revive-${r.id}`} label="되살리기" dimColor onPress={() => reviveSession($, r)} />
                </Box>
                <Text dimColor wrap="truncate">
                  {line(r)}
                </Text>
              </Box>
            ))}
        </Box>,
      )
    }

    // 전역 칸: 기한 메모(날짜 순, 기1·기2)가 맨 위, 그 아래 전역 메모(전1·전2)
    const items =
      open === 'global'
        ? [...due.map((m, i) => ({ m, no: `기${i + 1}` })), ...global.map((m, i) => ({ m, no: `전${i + 1}` }))]
        : list.map((m, i) => ({ m, no: `${i + 1}` }))
    const isKind = (m: Memo) => (open === 'global' ? Boolean(m.global || m.due) : !m.global && !m.due)
    const recent = (await read($, done)).filter(isKind).slice(0, KEEP_DONE)

    return wrap(
      <Box flexDirection="column">
        {menu}
        {items.length === 0 && <Text dimColor>없음 — {HINT[open]}</Text>}
        {items.map(({ m, no }) => (
          <Box key={`m${m.id}`}>
            <Button key={`done-${m.id}`} label="[ ]" plain onPress={() => resolve($, m.id)} />
            <Text wrap="wrap" {...(m.due && dday(m.due).startsWith('D+') ? { color: 'warning' } : {})}>
              {' '}
              {no}. {m.due ? `${dday(m.due)} ${m.due.slice(5)} ` : ''}
              {m.text}
            </Text>
          </Box>
        ))}
        {recent.map(m => (
          <Text dimColor strikethrough wrap="truncate">
            ✓ {m.text}
          </Text>
        ))}
      </Box>,
    )
  })
}
