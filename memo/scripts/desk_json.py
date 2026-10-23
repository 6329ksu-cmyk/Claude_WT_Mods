"""메뉴판 세션 칸용: recent_sessions.py --desk와 같은 목록을 JSON으로 출력만 한다.

--desk와 달리 snapshots/latest.json을 쓰지 않는다. /done 번호가 그 파일 기준이라, 주기적으로 덮어쓰면 번호가 몰래 바뀐다.
메뉴판을 띄운 세션 자신도 목록에 넣는다: rs는 CLAUDE_CODE_SESSION_ID 세션을 빼는데, 그건 복구 데스크 세션용이다.
"""

import json
import os
import re
import subprocess
import sys
import time

os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
sys.path.insert(0, os.path.expanduser("~/.claude/scripts"))
import recent_sessions as rs  # noqa: E402

# Windows Terminal 창마다 탭 이름(UI Automation). 실행 중인 프로그램 정보로는 어느 창인지 알 수 없어 탭 이름으로 맞춘다(2026-10-12 확인)
WIN_PS = r"""
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$wins = $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, (New-Object Windows.Automation.PropertyCondition($A::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')))
$tab = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
ConvertTo-Json -Compress -Depth 3 @($wins | ForEach-Object {
  $r = $_.Current.BoundingRectangle
  [pscustomobject]@{
    min = "$($_.GetCurrentPropertyValue([Windows.Automation.WindowPattern]::WindowVisualStateProperty))" -eq 'Minimized'
    x = $r.X; y = $r.Y
    tabs = @($_.FindAll([Windows.Automation.TreeScope]::Descendants, $tab) | ForEach-Object { $_.Current.Name })
  }
})
"""


def tab_key(name):
    """Claude 탭 이름 앞의 상태 기호(✳ ◑ 등)를 떼고 맞춘다"""
    return re.sub(r"^\W+", "", name or "").strip()


def window_of_tabs():
    """탭 이름 → 창 번호(왼쪽 창부터 1, 최소화한 창은 뒤). 창이 하나뿐이면 번호가 쓸모없어 빈 dict, 못 읽어도 빈 dict.
    Mac(Orca·터미널)은 Windows Terminal이 없어 바로 빈 dict(2026-10-21)"""
    if os.name != "nt":
        return {}
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", WIN_PS], capture_output=True, text=True,
                             encoding="utf-8", errors="ignore", timeout=20).stdout
        wins = json.loads(out or "[]")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {}
    if len(wins) < 2:
        return {}
    wins.sort(key=lambda w: (w["min"], w["x"], w["y"]))
    return {tab_key(t): i for i, w in enumerate(wins, 1) for t in w["tabs"]}


def main(hours=24.0):
    data = rs.desk_data(hours)
    live, labels, rows = data["live"], data["labels"], data["rows"]
    wins = window_of_tabs()
    print(json.dumps([
        dict(id=s["id"], tool=s["tool"], name=rs.name_of(s, labels), live=s["id"] in live, state=s["state"], kept=s["kept"], tomorrow=s.get("tomorrow", False),
             win=wins.get(tab_key(rs.name_of(s, labels))) if s["id"] in live else None,
             last=time.strftime("%m-%d %H:%M", time.localtime(s.get("mtime", s.get("opened", data["end"])))),
             cwd=s["cwd"], **rs.desk_details(s, labels))
        for s in rows
    ] + [  # 최근에 끝낸 세션 5개: 메뉴판에서 눌러 보고 [되살리기]
        dict(id=s["id"], tool=s["tool"], name=rs.name_of(s, labels), live=s["id"] in live, state=s["state"], kept=False, done=True,
             last=time.strftime("%m-%d %H:%M", time.localtime(s["mtime"])), cwd=s["cwd"])
        for s in data["done_rows"][:5]
    ], ensure_ascii=False))


def sweep(base=os.path.expanduser("~/.claude/mods"), now=None):
    """메뉴판 상태판(memo-live)·받은 답(memo-inbox)은 세션마다 파일이 하나씩 쌓인다.

    하루 넘게 안 바뀐 상태 파일(1분마다 다시 쓰니 그 세션은 꺼진 것)과 일주일 넘은 빈 받은 답 파일만 지운다.
    아직 안 보낸 답이 든 받은 답 파일은 그 세션을 다시 열 때까지 둔다.
    """
    now = now or time.time()
    for sub, age, only_empty in (("memo-live", 86400, False), ("memo-inbox", 7 * 86400, True)):
        folder = os.path.join(base, sub)
        for name in os.listdir(folder) if os.path.isdir(folder) else []:
            path = os.path.join(folder, name)
            try:
                if not name.endswith(".json") or now - os.path.getmtime(path) <= age:
                    continue
                if only_empty:
                    with open(path, encoding="utf-8") as f:
                        if f.read().strip() not in ("", "[]"):
                            continue
                os.remove(path)
            except OSError:
                pass


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sweep()
    main(float(sys.argv[1]) if len(sys.argv) > 1 else 24.0)
