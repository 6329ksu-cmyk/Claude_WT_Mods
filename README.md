# Claude_WT_Mods

Windows Terminal과 Mac(Orca·터미널)에서 쓰는 Claude Code mods 여섯 개: `memo`(메뉴판), `fm`(작업 중 강아지), `slash-ko`(슬래시 메뉴 한국어), `aside`(옆 질문 창), `watchdog`(답 검사), `token-weather-usage`(사용량 날씨 줄).

## 설치

터미널에서 Claude Code를 열고 프롬프트에 친다. `Add marketplace?`에 `y`, 범위는 맨 위 user에서 Enter. 설정 파일은 손대지 않아도 된다.

```
/plugin install memo --marketplace 6329ksu-cmyk/Claude_WT_Mods
```

memo가 나머지 다섯 개를 함께 쓰도록 되어 있어 이 한 줄로 여섯 개가 다 깔린다(`+ 5 dependencies`).
셸에서는 `claude plugin install memo --marketplace 6329ksu-cmyk/Claude_WT_Mods`.
데스크톱 앱에서는 프롬프트 옆 + → Plugins → Add marketplace에 `6329ksu-cmyk/Claude_WT_Mods` → Add plugin.

Claude Code에 내장된 You should know(옆 AI가 놓친 점을 카드로)는 켜기만 한다.

```
claude plugin enable cc-plugin-you-should-know@builtin
```

설치 뒤:
- 작업 중 강아지는 바로 켜져 있다. 싫으면 `/calm`으로 끈다.
- watchdog은 기본 꺼짐. 쓸 탭에서 `/watchdog on`. 설정 없이 켜면 opus가 단계마다 검사해 비싸니 먼저 `watchdog/WATCHDOG.example.json`을 `~/.claude/WATCHDOG.json`으로 복사한다(sonnet·답 끝에만·한국어 메모). `/watchdog status`로 읽혔는지 본다.
- aside는 `/aside`로 연다.

비공개 저장소면 GitHub에서 초대받은 계정으로 그 PC에 `gh auth login` 뒤 `gh auth setup-git`을 해 둬야 설치된다.

업데이트: `claude plugin update memo@claude-wt-mods` (다른 것도 같은 식) 뒤 Claude Code를 다시 연다.

예전 이름(`Cluade_Mods`, `cluade-mods`)으로 깐 PC는 `claude plugin marketplace remove cluade-mods` 뒤 위 설치 한 줄을 다시 친다.

## 들어 있는 것

| mod | 하는 일 |
|---|---|
| `memo` | 입력창 위 메뉴판. 메모 칸(전역·세션·기한, "메모해"), 흐름 칸(목표·지금·다음 요약, 내 질문 번호로 그 자리 이동), 세션 칸(다른 Claude·Codex 세션 실행 중·꺼짐, 열기·끝·킵, [내일]로 체크해 두면 다음 날 [내일 열 것 N개 열기]로 한 번에 열고 일하다 끊긴 것만 "이어서해"), 맨 오른쪽 모델·컨텍스트 칸(모델·effort, 컨텍스트 몇 % 찼는지), 한도 90% 알림 |
| `fm` | [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate)의 firstmate-calm. 도구 줄을 감추고, 작업 중 표시 자리에 회색 강아지(3줄)가 걸어 다닌다. 백그라운드 조사만 도는 동안은 입력창 위에 앉아 `조사 N개 기다리는 중`. 강아지는 [claude-pets](https://github.com/uppinote20/claude-pets)(MIT) 그림에서 시작. 돛단배로 되돌리려면 `lib/fm-calm-pet.ts`의 `SHOW_BOAT = true`. MIT, 로컬 수정은 `firstmate-calm/SOURCE.txt` |
| `slash-ko` | `/`를 누르면 뜨는 명령·스킬 설명을 한국어 한 줄로. 처음 메뉴를 열 때 Haiku로 번역해 두고 다음부터는 저장본을 쓴다. AI가 스킬을 고를 때 읽는 목록은 영어 원문으로 되돌려 둔다 |
| `aside` | [escapeboy/claude-code-kit](https://github.com/escapeboy/claude-code-kit)의 aside. `/aside`로 연 옆 창에서 이 대화를 아는 도구 없는 복제 AI가 답하고, 본 대화엔 남지 않는다. ✕·Esc로 닫는다. MIT, 한국어·답 모양 로컬 수정은 `aside/SOURCE.txt` |
| `watchdog` | [matteoantoci/claude-code-watchdog](https://github.com/matteoantoci/claude-code-watchdog). 옆 AI가 답 끝마다 검사해 놓친 점을 짧게 알린다. Apache-2.0, Windows에서 설정 파일을 못 찾던 문제(HOME 없음) 로컬 수정은 `watchdog/SOURCE.txt` |
| `token-weather-usage` | [augiefra/claude-mods](https://github.com/augiefra/claude-mods)의 token-weather-usage를 수정 없이 담음. 입력창 위 한 줄에 대화칸 날씨·5h/7일 한도·캐시 남은 시간·비용·도는 서브에이전트. memo 메뉴판 맨 아래에 붙는다. 글자는 영어/프랑스어/러시아어. Apache-2.0(`LICENSE`·`NOTICE`) |

## slash-ko가 쓰는 것

- 번역 사전: `~/.claude/mods/slash-ko-data.json` (`{명령: {en, ko}}`). `ko`를 손으로 고치면 원문이 바뀔 때까지 그 문구를 쓴다. 새 스킬·바뀐 설명만 다시 번역한다
- Codex: mod 기능이 없어 스킬 파일의 화면용 설명(`metadata.short-description`)을 채우는 스크립트를 함께 둔다. `~/.codex/skills`·`~/.agents/skills`의 SKILL.md를 고치며(원본은 `~/.claude/mods/_backup/codex-skills-before-ko/`), 스킬이 업데이트돼 영어로 돌아가면 다시 돌린다. 다른 저장소·플러그인 캐시로 이어진 링크 스킬은 그 파일이 바뀌니 건너뛴다(Mac은 대부분이 링크). Python 3·PyYAML(Mac은 Homebrew `python3`), 사전에 없는 것은 `claude -p`로 번역. Codex 기본 명령(`/compact` 등)은 못 바꾼다

```
python slash-ko/scripts/codex_ko.py --dry   # 바꿀 것만 보기 (Mac은 python3)
python slash-ko/scripts/codex_ko.py         # 적용
```

## memo가 쓰는 것

- 메모·흐름·상태 파일: `~/.claude/mods/memo-data.json`, `~/.claude/mods/memo-flow/`, `~/.claude/mods/memo-live/` (없으면 만든다)
- 세션 칸: 스크립트는 `memo/scripts/`에 함께 있다
  - Windows: Python 3(`%LOCALAPPDATA%\Programs\Python\Python312` 또는 `py` 런처), 실행 중 판정은 PowerShell, [열기]는 Windows Terminal
  - Mac: Homebrew `python3`(없으면 `/usr/bin/python3`), 실행 중 판정은 `ps`, [열기]는 Orca 안이면 Orca 새 탭, 아니면 터미널(Terminal.app) 새 창. 창 번호는 Windows Terminal에만 있다
