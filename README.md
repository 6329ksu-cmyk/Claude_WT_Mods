# Cluade_Mods

Claude Code mods 두 개: `memo`(메뉴판)와 `fm`(돛단배).

## 설치

터미널에서 Claude Code를 열고 프롬프트에 친다. `Add marketplace?`에 `y`, 범위는 맨 위 user에서 Enter. 설정 파일은 손대지 않아도 된다.

```
/plugin install memo --marketplace 6329ksu-cmyk/Cluade_Mods
```

memo가 `fm`(돛단배)을 함께 쓰도록 되어 있어 이 한 줄로 둘 다 깔린다(`+ 1 dependency: fm`).
셸에서는 `claude plugin install memo --marketplace 6329ksu-cmyk/Cluade_Mods`.
데스크톱 앱에서는 프롬프트 옆 + → Plugins → Add marketplace에 `6329ksu-cmyk/Cluade_Mods` → Add plugin.

돛단배는 설치하면 바로 켜져 있다. 싫으면 `/calm`으로 끈다.

비공개 저장소면 GitHub에서 초대받은 계정으로 그 PC에 `gh auth login` 뒤 `gh auth setup-git`을 해 둬야 설치된다.

업데이트: `claude plugin update memo@cluade-mods` (fm도 같은 식) 뒤 Claude Code를 다시 연다.

## 들어 있는 것

| mod | 하는 일 |
|---|---|
| `memo` | 입력창 위 메뉴판. 메모 칸(전역·세션·기한, "메모해"), 흐름 칸(목표·지금·다음 요약, 내 질문 번호로 그 자리 이동), 세션 칸(다른 Claude·Codex 세션 실행 중·꺼짐, 열기·끝·킵), 맨 아래 ⏱ 사용량 줄(5h·주 한도, 대화칸, 모델·effort) |
| `fm` | [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate)의 firstmate-calm. 도구 줄을 감추고 작업 중 표시를 돛단배로. MIT, 로컬 수정은 `firstmate-calm/SOURCE.txt` |

## memo가 쓰는 것

- 메모·흐름·상태 파일: `~/.claude/mods/memo-data.json`, `~/.claude/mods/memo-flow/`, `~/.claude/mods/memo-live/` (없으면 만든다)
- 세션 칸: Windows, Python 3(`%LOCALAPPDATA%\Programs\Python\Python312` 또는 `py` 런처), [열기]는 Windows Terminal. 스크립트는 `memo/scripts/`에 함께 있다
