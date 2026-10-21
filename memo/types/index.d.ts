// global이면 모든 세션, due(YYYY-MM-DD)가 있으면 기한 메모로 모든 세션, 둘 다 없으면 session(적은 세션)에서만 보인다
export type Memo = { id: number; text: string; at: string; session?: string; global?: true; due?: string }

// 메뉴판 세션 칸: desk_json.py가 내는 한 줄
// kept: 킵(급하지 않아 나중에 할 것). 세션 칸 아래쪽에 모이고, 복구 때 '전부 열기'에서 빠진다
// me: 메뉴판을 띄운 바로 이 세션('지금' 칸에 이름이 보인다)
// doing: 그 세션이 하던 일(흐름 요약의 기다리는 답·지금, 요약 없으면 마지막 요청). last_user는 desk_json.py가 낸 마지막 요청
export type DeskRow = {
  id: string
  tool: string
  name: string
  live: boolean
  state: string
  last: string
  kept?: boolean
  me?: boolean
  done?: boolean
  last_user?: string
  doing?: string
  // 그 세션 탭이 있는 Windows Terminal 창 번호(왼쪽 창부터 1). 창이 하나뿐이거나 탭을 못 찾으면 없음
  win?: number | null
}

// 열린 칸: '' = 닫힘
export type Tab = '' | 'global' | 'session' | 'desk' | 'flow'

// 흐름 칸: 이 세션을 처음부터 지금까지 요약한 것. count는 요약할 때의 대화 수(그 뒤 새 대화 수를 알려 준다)
// waiting은 AI가 지금 사용자에게 기다리는 답(없으면 ''). 답이 끝날 때마다 이전 요약에 이번 대화만 더해 고친다
// of: 요약에 반영한 마지막 답의 끝 40자(다시 불러온 뒤 끊긴 갱신이 있었는지 보는 표시)
export type Flow = { at: string; count: number; goal: string; steps: string[]; now: string; waiting?: string; next: string; decisions?: Decision[]; of?: string }

// 결정 카드(10-20 사용자: "1번 추천해요" 할 때 앞 내용이 잘려 1번이 뭔지 모름): 방금 AI 답이 고르라고 한 것.
// why: 앞 흐름(왜 지금 이 결정이 나왔나) · then: 뒤 흐름(고르면 다음에 생기는 일) · pick: AI 추천 key
export type Decision = { ask: string; why: string; options: { key: string; label: string; then: string }[]; pick: string; reason: string }

// 세션 상태판(mods/memo-live/<세션 id>.json): 세션마다 자기 파일만 쓰고 다른 세션은 읽기만 한다.
// working 답하는 중 · waiting 사용자 답을 기다림 · idle 할 일 없음 · off 닫힘. 1분마다 다시 써서 3분 넘게 안 바뀌면 꺼진 것으로 본다
// at: 그 세션 흐름 요약 시각(바뀌면 다른 세션이 세션 칸 '하던 일'을 새로 읽는다)
// typed: 사용자가 그 세션에 마지막으로 뭔가 보낸 때 · doing: 그 세션 흐름 요약의 기다리는 답 또는 지금(돌아오면 브리핑에 쓴다)
export type Live = { id: string; state: 'working' | 'waiting' | 'idle' | 'off'; why: string; since: number; name: string; at?: string; typed?: number; doing?: string }

// 돌아오면 브리핑: 모든 탭에서 아무것도 안 보낸 지 mins분, 그사이 답 기다림·끝남으로 바뀐 다른 탭(3개까지)
export type Brief = { mins: number; items: Live[] }

// 사용량 줄(statusline 대신, 10-19): 엔진이 statusline에 주는 숫자 그대로. 아직 못 받은 값은 비워 둔다(0으로 채우지 않음)
// limits: 5h·주 한도(percentUsed 0~100, resetsAt ISO 시각) · ctx: 대화칸 %
export type Meter = { limits: { kind: string; percentUsed: number; resetsAt?: string }[]; ctx?: number; model: string; effort: string }


declare module 'claude-code' {
  interface PluginState {
    memo: {
      list: Memo[]
      globals: Memo[]
      dues: Memo[]
      done: Memo[]
      tab: Tab
      desk: DeskRow[] | null
      showEnded: boolean
      moreDesk: boolean
      flow: Flow | null
      flowNote: string
      peers: Live[]
      asked: string[]
      showAsked: boolean
      meter: Meter | null
      whyOpen: boolean
      brief: Brief | null
    }
  }
}
