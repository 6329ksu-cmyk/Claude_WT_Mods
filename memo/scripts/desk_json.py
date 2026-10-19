"""메뉴판 세션 칸용: recent_sessions.py --desk와 같은 목록을 JSON으로 출력만 한다.

--desk와 달리 snapshots/latest.json을 쓰지 않는다. /done 번호가 그 파일 기준이라, 주기적으로 덮어쓰면 번호가 몰래 바뀐다.
메뉴판을 띄운 세션 자신도 목록에 넣는다: rs는 CLAUDE_CODE_SESSION_ID 세션을 빼는데, 그건 복구 데스크 세션용이다.
"""

import json
import os
import sys
import time

os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
sys.path.insert(0, os.path.expanduser("~/.claude/scripts"))
import recent_sessions as rs  # noqa: E402


def main(hours=24.0):
    data = rs.desk_data(hours)
    live, labels, rows = data["live"], data["labels"], data["rows"]
    print(json.dumps([
        dict(id=s["id"], tool=s["tool"], name=rs.name_of(s, labels), live=s["id"] in live, state=s["state"], kept=s["kept"],
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
