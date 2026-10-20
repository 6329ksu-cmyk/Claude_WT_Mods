import type { EngineInterface, Register } from 'claude-code'

// 슬래시(/) 메뉴와 /help에 뜨는 설명을 한국어 한 줄로 바꾼다.
// 번역은 JSON 파일 하나에 모아 다음 세션부터 바로 쓴다. 원문(en)이 바뀐 명령만
// 다시 번역하고, ko를 손으로 고쳐 두면 원문이 바뀔 때까지 그 문구를 쓴다.

type Data = Record<string, { en: string; ko: string }>

const BATCH = 40
const HANGUL = /[가-힣]/

let data: Data = {}
let loaded = false
const pending = new Map<string, string>() // 번역할 명령 → 원문
const tried = new Set<string>() // 실패해도 세션당 한 번만 시도
let queued = false
let busy = false

const home = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
const file = async ($: EngineInterface) => `${await home($)}/.claude/mods/slash-ko-data.json`

// 파일이 없으면 빈 사전. 깨진 파일은 throw해서 아무것도 덮어쓰지 않는다
const load = async ($: EngineInterface): Promise<Data> => {
  const path = await file($)
  if (!(await $.fs.exists(path))) return {}
  return JSON.parse(await $.fs.read(path)) as Data
}

// /reload-plugins는 session.start 없이 모듈만 새로 띄우므로 첫 hook에서 사전을 읽는다
let reading: Promise<void> | undefined
const ready = ($: EngineInterface) =>
  (reading ??= load($).then(
    d => {
      data = d
      loaded = true
    },
    () => $.ui.log('slash-ko: slash-ko-data.json을 읽지 못해 새 번역을 멈춤'),
  ))

export const ask = (items: Record<string, string>) => `Claude Code 슬래시(/) 메뉴에 뜰 명령 설명을 한국어로 옮긴다.
- 명령마다 한 줄, 40자 안팎. 길면 무엇을 하는지만 남기고 줄인다.
- 기술 용어·제품명(PR, MCP, hook, Git, Chrome 등)은 영어 그대로 둔다.
- 마침표 없이 "~하기"·명사형으로 짧게.
- 입력의 키를 그대로 쓴 JSON 객체 하나만 답한다: {"명령": "설명"}

${JSON.stringify(items, null, 1)}`

export const parse = (text: string): Record<string, string> | undefined => {
  const m = text.match(/\{[\s\S]*\}/)
  try {
    return m ? (JSON.parse(m[0]) as Record<string, string>) : undefined
  } catch {
    return undefined
  }
}

async function flush($: EngineInterface) {
  if (busy) return
  busy = true
  try {
    while (pending.size) {
      const items = [...pending].slice(0, BATCH)
      for (const [name] of items) pending.delete(name)
      const r = await $.model.complete({
        model: 'haiku',
        prompt: ask(Object.fromEntries(items.map(([name, en]) => [name, en.slice(0, 500)]))),
        maxTokens: 8000,
        effort: 'low',
        timeoutMs: 120_000,
      })
      const got = r.isAnswered ? parse(r.text) : undefined
      if (!got) {
        $.ui.log(`slash-ko: 번역 ${items.length}개 실패 (${r.isAnswered ? 'JSON 아님' : r.reason})`)
        continue
      }
      const latest = await load($) // 다른 세션이 그사이 쓴 번역과 합친다
      for (const [name, en] of items) {
        const ko = got[name]
        if (typeof ko === 'string' && ko.trim()) latest[name] = { en, ko: ko.trim() }
      }
      await $.fs.write(await file($), JSON.stringify(latest, null, 2))
      data = latest
      $.ui.invalidate('command.describe')
    }
  } finally {
    busy = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ready($)
    // 메뉴를 처음 열 때 번역이 이미 있도록 미리 한 번 훑는다
    void $.clock.after(3000, () => void $.command.list().catch(() => undefined))
    return next(e)
  })

  on('command.describe', async ($, e, next) => {
    await ready($)
    const hit = data[e.command]
    if (hit && hit.en === e.description) return next({ ...e, description: hit.ko })
    if (loaded && !e.isHidden && e.description && !HANGUL.test(e.description) && !tried.has(e.command)) {
      tried.add(e.command)
      pending.set(e.command, e.description)
      if (!queued) {
        queued = true
        void $.clock.after(2000, () => {
          queued = false
          void flush($).catch(err => $.ui.log(`slash-ko: ${String(err)}`))
        })
      }
    }
    return next(e)
  })

  // 모델이 스킬을 고를 때 읽는 목록도 위 설명으로 만들어지므로, 거기엔 영어 원문을 되돌린다
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    await ready($)
    let text = e.text
    for (const [name, { en, ko }] of Object.entries(data)) text = text.replace(`- ${name}: ${ko}`, () => `- ${name}: ${en}`)
    return next({ ...e, text })
  })
}
