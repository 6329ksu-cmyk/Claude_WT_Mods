# Cluade_Mods

Claude Code mods 세 개: `memo`(메뉴판), `fm`(작업 중 강아지), `slash-ko`(슬래시 메뉴 한국어).

## 설치

터미널에서 Claude Code를 열고 프롬프트에 친다. `Add marketplace?`에 `y`, 범위는 맨 위 user에서 Enter. 설정 파일은 손대지 않아도 된다.

```
/plugin install memo --marketplace 6329ksu-cmyk/Cluade_Mods
```

memo가 `fm`을 함께 쓰도록 되어 있어 이 한 줄로 둘 다 깔린다(`+ 1 dependency: fm`).
셸에서는 `claude plugin install memo --marketplace 6329ksu-cmyk/Cluade_Mods`.
데스크톱 앱에서는 프롬프트 옆 + → Plugins → Add marketplace에 `6329ksu-cmyk/Cluade_Mods` → Add plugin.

작업 중 강아지는 설치하면 바로 켜져 있다. 싫으면 `/calm`으로 끈다.

사용량 줄(5h·주 한도, 대화칸)은 memo에서 빼고 남의 mod [token-weather-usage](https://github.com/augiefra/claude-mods)를 쓴다. 깔면 memo 메뉴판 맨 아래에 붙는다.

```
/plugin marketplace add https://statuslin.es/marketplace.json
/plugin install token-weather-usage@statuslines
```

슬래시 메뉴 한국어는 따로 깐다.

```
/plugin install slash-ko --marketplace 6329ksu-cmyk/Cluade_Mods
```

비공개 저장소면 GitHub에서 초대받은 계정으로 그 PC에 `gh auth login` 뒤 `gh auth setup-git`을 해 둬야 설치된다.

업데이트: `claude plugin update memo@cluade-mods` (fm도 같은 식) 뒤 Claude Code를 다시 연다.

## 들어 있는 것

| mod | 하는 일 |
|---|---|
| `memo` | 입력창 위 메뉴판. 메모 칸(전역·세션·기한, "메모해"), 흐름 칸(목표·지금·다음 요약, 내 질문 번호로 그 자리 이동), 세션 칸(다른 Claude·Codex 세션 실행 중·꺼짐, 열기·끝·킵), 맨 오른쪽 모델 칸(모델·effort), 한도 90% 알림 |
| `fm` | [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate)의 firstmate-calm. 도구 줄을 감추고, 작업 중 표시 자리에 회색 강아지(3줄)가 걸어 다닌다. 백그라운드 조사만 도는 동안은 입력창 위에 앉아 `조사 N개 기다리는 중`. 강아지는 [claude-pets](https://github.com/uppinote20/claude-pets)(MIT) 그림에서 시작. 돛단배로 되돌리려면 `lib/fm-calm-pet.ts`의 `SHOW_BOAT = true`. MIT, 로컬 수정은 `firstmate-calm/SOURCE.txt` |
| `slash-ko` | `/`를 누르면 뜨는 명령·스킬 설명을 한국어 한 줄로. 처음 메뉴를 열 때 Haiku로 번역해 두고 다음부터는 저장본을 쓴다. AI가 스킬을 고를 때 읽는 목록은 영어 원문으로 되돌려 둔다 |

## slash-ko가 쓰는 것

- 번역 사전: `~/.claude/mods/slash-ko-data.json` (`{명령: {en, ko}}`). `ko`를 손으로 고치면 원문이 바뀔 때까지 그 문구를 쓴다. 새 스킬·바뀐 설명만 다시 번역한다
- Codex: mod 기능이 없어 스킬 파일의 화면용 설명(`metadata.short-description`)을 채우는 스크립트를 함께 둔다. `~/.codex/skills`·`~/.agents/skills`의 SKILL.md를 고치며(원본은 `~/.claude/mods/_backup/codex-skills-before-ko/`), 스킬이 업데이트돼 영어로 돌아가면 다시 돌린다. Python 3·PyYAML, 사전에 없는 것은 `claude -p`로 번역. Codex 기본 명령(`/compact` 등)은 못 바꾼다

```
python slash-ko/scripts/codex_ko.py --dry   # 바꿀 것만 보기
python slash-ko/scripts/codex_ko.py         # 적용
```

## memo가 쓰는 것

- 메모·흐름·상태 파일: `~/.claude/mods/memo-data.json`, `~/.claude/mods/memo-flow/`, `~/.claude/mods/memo-live/` (없으면 만든다)
- 세션 칸: Windows, Python 3(`%LOCALAPPDATA%\Programs\Python\Python312` 또는 `py` 런처), [열기]는 Windows Terminal. 스크립트는 `memo/scripts/`에 함께 있다
