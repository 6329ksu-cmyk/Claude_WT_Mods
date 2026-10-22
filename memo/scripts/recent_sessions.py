"""터미널이 꺼졌을 때 최근 Claude Code·Codex 세션을 찾아 Windows Terminal 탭으로 다시 연다.

사용(시간 기준은 '지금'이 아니라 '마지막으로 끊긴 세션의 마지막 기록 시각'이라 주말·연휴 뒤에도 같다):
  python recent_sessions.py --desk [시간] # 복구 데스크: 끊기기 직전 세션 + 열어 뒀던 세션을 합쳐 보여 주고 snapshots/latest.json 저장(기본 24시간, 열지 않음)
  python recent_sessions.py --desk-preview [시간] # 같은 근거를 읽되 snapshot·done 번호를 바꾸지 않는 미리보기
  python recent_sessions.py --serve      # 기간 버튼(3일·1주·2주·1개월)·검색·체크해서 열기 화면(브라우저)
  python recent_sessions.py              # 끊기기 직전 6시간 세션 목록(자세히)
  python recent_sessions.py 24           # 끊기기 직전 24시간
  python recent_sessions.py --ask        # 한 줄 목록 보고 번호 고르기(Enter=전부(킵 제외), +24=더 거슬러, q=취소)
  python recent_sessions.py --keep id    # 킵(급하지 않아 나중에 할 것) 표시, --unkeep으로 해제. 목록엔 보이고 '전부 열기'에서만 빠진다
  python recent_sessions.py 6 --open all # 묻지 않고 전부 열기
  python recent_sessions.py 6 --open 1,3,5
  python recent_sessions.py --from 저장한목록.json   # 저장해 둔 목록 그대로 열기
  python recent_sessions.py --open-desk 1,3   # 최근 --desk 목록 번호 그대로 열기(all = 킵 뺀 전부). 연 뒤 실제로 떴는지 확인해 알린다
바탕화면 AI세션보기.cmd = --serve, 비상용 - AI 세션 전부 열기.cmd = --ask. 탭은 명령 프롬프트 프로필, 실행 중인 세션은 건너뛴다.
시간은 파일 수정 시각이 아니라 기록 안의 마지막 시각으로 본다(Codex는 수정 시각이 늦게 바뀜).
같은 첫 질문으로 갈라진 사본은 가장 최근 것만, Codex 하위 agent는 빼고 본다. agy는 아직 포함하지 않는다.
기록 파일은 앞(첫 질문·폴더)과 뒤(마지막 질문·답)만 읽는다. 한 달치도 수 초 안에 끝나게 하려는 것이다.
Mac(2026-10-21): 실행 중 판정은 ps로, 여는 곳은 Orca 안이면 Orca 새 탭, 아니면 터미널(Terminal.app) 새 창이다.
"""
import glob, json, mmap, os, re, shlex, subprocess, sys, tempfile, time
from datetime import datetime
from pathlib import PureWindowsPath

WINDOWS = os.name == "nt"
ORCA = "/Applications/Orca.app/Contents/Resources/bin/orca"
# 명령 안 따옴표 속 절대경로: Windows는 C:\·/c/(Git Bash), Mac은 흔한 최상위 폴더와 ~/
ABS_PATH = r"[A-Za-z]:[\\/]|/[a-zA-Z]/" if WINDOWS else r"/(?:Users|Volumes|private|tmp|opt|Applications|Library)/|~/"

HOME = os.path.expanduser("~")
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
CMD_PROFILE = "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}"  # Windows Terminal '명령 프롬프트'


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") in ("text", "input_text", "output_text"))
    return ""


def is_human(t):
    t = t.strip()
    return bool(t) and not t.startswith(("<", "[Request interrupted", "# AGENTS")) and "AGENTS.md" not in t[:200]


def last_time(f):
    """기록 끝부분에서 마지막 timestamp를 읽는다. 못 찾으면 파일 수정 시각.
    Claude가 혼자 남기는 기록(자리 비움 요약·'memo: reloaded' 알림)은 대화가 아니라 건너뛴다.
    세지 않으면 /done 뒤 3분쯤 생긴 자리 비움 요약 때문에 숨긴 세션이 되살아났다(2026-10-08)."""
    with open(f, "rb") as h:
        h.seek(0, 2)
        h.seek(max(0, h.tell() - 65536))
        lines = h.read().decode("utf-8", "ignore").splitlines()
    for line in reversed(lines):
        try:
            d = json.loads(line)
            ts = d.get("timestamp")
        except (ValueError, AttributeError):
            continue
        if d.get("subtype") in ("away_summary", "informational"):
            continue
        if ts:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    return os.path.getmtime(f)


def tail_lines(f, nbytes):
    """파일 끝 nbytes의 줄들. 잘린 첫 줄은 버린다. (줄들, 앞부분이 더 남았는지)"""
    with open(f, "rb") as h:
        h.seek(0, 2)
        size = h.tell()
        h.seek(max(0, size - nbytes))
        lines = h.read().decode("utf-8", "ignore").splitlines()
    return (lines[1:] if size > nbytes else lines), size > nbytes


def jsonl(lines):
    for line in lines:
        try:
            yield json.loads(line)
        except ValueError:
            continue


def excerpt(t, n=1200):
    """문맥이 긴 경우 끝의 질문·남은 일도 보존한다."""
    t = (t or "").strip()
    return t if len(t) <= n else t[:n * 2 // 3] + " …(중간 생략)… " + t[-n // 3:]


def recent_context(lines, tool, cwd):
    """기록 끝에서 사용자 요청·답과 작업 경로만 읽는다. 명령을 실행하지 않는다."""
    chat, files, changed, dirs = [], [], [], []

    def remember(items, value):
        if value in items:
            items.remove(value)
        items.append(value)

    def path(value, base, modified=False):
        if not isinstance(value, str) or not value.strip() or "://" in value:
            return
        value = value.strip()
        if not WINDOWS:  # Mac: Windows 경로로 읽으면 /Users/… 가 \Users\… 로 바뀐다
            p = os.path.normpath(os.path.join(base or HOME, os.path.expanduser(value)))
            remember(files, p)
            if modified:
                remember(changed, p)
            return
        unc = value.startswith("\\\\")
        value = re.sub(r"\\+", r"\\", value)
        if unc:
            value = "\\" + value
        if re.match(r"^/[a-zA-Z]/", value):  # Git Bash 경로
            value = value[1] + ":" + value[2:]
        p = PureWindowsPath(value)
        if not p.is_absolute():
            p = PureWindowsPath(base) / p
        remember(files, str(p))
        if modified:
            remember(changed, str(p))

    def inputs(value, base, modified=False):
        if isinstance(value, dict):
            base = value.get("workdir") or value.get("cwd") or base
            for key, item in value.items():
                if key in ("file_path", "path", "notebook_path"):
                    path(item, base, modified)
                elif key in ("workdir", "cwd") and isinstance(item, str):
                    remember(dirs, item)
                elif isinstance(item, (dict, list)):
                    inputs(item, base, modified)
                elif key in ("command", "cmd", "script", "input", "patch"):
                    inputs(item, base, modified)
        elif isinstance(value, list):
            for item in value:
                inputs(item, base, modified)
        elif isinstance(value, str):
            for match in re.finditer(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$", value, re.M):
                path(match.group(1), base, True)
            # 명령 전체 대신 따옴표 안의 절대경로만 근거로 남긴다.
            for match in re.finditer(r"[\"']((?:" + ABS_PATH + r")[^\"'\r\n]+)[\"']", value):
                path(match.group(1), base)

    for d in jsonl(lines):
        if d.get("isSidechain") or d.get("subtype") in ("away_summary", "informational"):
            continue
        base = d.get("cwd") or cwd
        if d.get("cwd"):
            remember(dirs, base)
        if tool == "claude":
            role = d.get("type")
            content = d.get("message", {}).get("content")
            blocks = content if isinstance(content, list) else []
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    inputs(block.get("input"), base, block.get("name") in ("Write", "Edit", "MultiEdit"))
        else:
            p = d.get("payload") or {}
            if d.get("type") == "turn_context":
                cwd = p.get("cwd") or cwd
                remember(dirs, cwd)
            if d.get("type") != "response_item":
                continue
            role, content = p.get("role"), p.get("content")
            if p.get("channel") == "analysis":
                continue
            if p.get("type") in ("function_call", "custom_tool_call"):
                value = p.get("arguments", p.get("input", ""))
                try:
                    value = json.loads(value) if isinstance(value, str) else value
                except ValueError:
                    pass
                inputs(value, cwd)
        t = text_of(content)
        if role == "user" and not d.get("isMeta") and is_human(t):
            chat.append(dict(role=role, text=excerpt(t)))
        elif role == "assistant" and t.strip():
            chat.append(dict(role=role, text=excerpt(t)))
    # 긴 작업의 진행 메시지가 마지막 승인 전의 목적을 밀어내지 않게 각각 보존한다.
    keep = set()
    for role in ("user", "assistant"):
        keep.update([i for i, item in enumerate(chat) if item["role"] == role][-3:])
    return dict(recent=[item for i, item in enumerate(chat) if i in keep],
                files=files[-8:], changed_files=changed[-8:], dirs=dirs[-4:])


STALE = 14 * 86400  # 수정 시각이 기록 시각보다 이만큼까지 옛날일 수 있다고 본다(Codex는 열려 있던 동안 수정 시각이 안 바뀜)
_FILES = (0, {})


def session_files():
    """{'claude': [(경로, 수정 시각)], 'codex': [...]}. 파일 수천 개를 매번 훑지 않게 10초간 재사용한다."""
    global _FILES
    if time.time() - _FILES[0] > 10:
        kinds = dict(claude=HOME + "/.claude/projects/*/*.jsonl", codex=HOME + "/.codex/sessions/**/*.jsonl")
        _FILES = (time.time(), {k: [(f, os.path.getmtime(f)) for f in glob.glob(g, recursive=True)] for k, g in kinds.items()})
    return _FILES[1]


def last_value(f, key):
    """기록 파일 전체에서 "key":"값"의 마지막 값. 이름을 바꾼 지 오래되면 뒤쪽 1MB에 없어 첫 질문 앞 12자로 보였다(2026-10-08)."""
    if not os.path.getsize(f):
        return None
    with open(f, "rb") as h, mmap.mmap(h.fileno(), 0, access=mmap.ACCESS_READ) as data:  # 수십 MB 기록도 통째로 복사하지 않는다
        i = data.rfind(b'"' + key.encode() + b'":')
        m = i >= 0 and re.match(rb'\s*("(?:[^"\\]|\\.)*")', data[i + len(key) + 3:i + len(key) + 1000])
        return json.loads(m.group(1)) if m else None


def codex_names():
    """Codex 탭 이름(자동 제목·/rename 모두)은 ~/.codex/session_index.jsonl에 id별로 덧붙는다. 마지막 줄이 지금 이름이다."""
    names = {}
    try:
        with open(HOME + "/.codex/session_index.jsonl", encoding="utf-8") as h:
            for d in jsonl(h):
                names[d.get("id")] = d.get("thread_name") or names.get(d.get("id"))
    except OSError:
        pass
    return names


def claude_sessions(since, files=None):
    for f, mtime in session_files()["claude"] if files is None else files:
        if mtime < since - STALE:  # 열려 있던 파일은 닫히기 전까지 수정 시각이 안 바뀌므로(2026-10-06 확인) 여유를 둔다
            continue
        sid = os.path.basename(f)[:-6]
        if sid == os.environ.get("CLAUDE_CODE_SESSION_ID"):  # 지금 이 창은 제외
            continue
        last = last_time(f)
        if last < since:
            continue
        # 백그라운드로 보내면 새 id(--fork-session)로 이어지고 원래 탭 프로세스도 살아 있어 같은 일이 '실행 중' 두 줄로 보였다(10-22 pin-restore). 이어진 쪽만 남긴다
        if last_value(f, "continuedInSessionId"):
            continue
        cwd = title = first = None
        with open(f, encoding="utf-8", errors="ignore") as h:  # 앞에서 폴더·첫 질문만 찾고 멈춘다
            for d in jsonl(h):
                cwd = cwd or d.get("cwd")
                if first is None and d.get("type") == "user" and not d.get("isSidechain") and not d.get("isMeta"):
                    t = text_of(d.get("message", {}).get("content"))
                    first = t if is_human(t) else None
                if cwd and first:
                    break
        if not (cwd and first):
            continue
        for nbytes in (1 << 20, 1 << 23, 1 << 26):  # 마지막 질문·답이 안 보이면 더 읽는다
            tail = last_ai = last_user = None
            lines, more = tail_lines(f, nbytes)
            for d in jsonl(reversed(lines)):
                if d.get("isSidechain") or d.get("subtype") in ("away_summary", "informational") or d.get("type") not in ("user", "assistant"):
                    continue
                content = d.get("message", {}).get("content")
                blocks = content if isinstance(content, list) else []
                if tail is None:
                    tail = "tool" if d["type"] == "assistant" and any(isinstance(c, dict) and c.get("type") == "tool_use" for c in blocks) else d["type"]
                if d["type"] == "assistant" and last_ai is None:
                    texts = [c["text"] for c in blocks if isinstance(c, dict) and c.get("type") == "text" and c["text"].strip()]
                    last_ai = texts[-1] if texts else None
                elif d["type"] == "user" and last_user is None and not d.get("isMeta") and is_human(text_of(content)):
                    last_user = text_of(content)
                if tail and last_ai and last_user:
                    break
            if not more or (tail and last_ai and last_user):
                break
        title = last_value(f, "customTitle")  # /rename. 없으면 Claude가 붙인 자동 제목(ai-title)을 탭 이름처럼 쓴다
        auto = last_value(f, "aiTitle")
        title_file = f[:-6] + "/custom-title.json"
        if os.path.exists(title_file):
            try:
                with open(title_file, encoding="utf-8") as h:
                    title = json.load(h).get("title") or title
            except ValueError:
                pass
        yield dict(tool="claude", src="cli", mtime=last, id=sid, cwd=cwd, title=title, auto=auto,
                   first=first, last_user=last_user or first, last_ai=last_ai,
                   state="답변 후 대기" if tail == "assistant" else "작업 중 끊김",
                   source=f, **recent_context(lines, "claude", cwd),
                   cmd=f"claude --resume {sid}")


def codex_sessions(since, files=None):
    for f, mtime in session_files()["codex"] if files is None else files:
        if mtime < since - STALE or os.path.getsize(f) == 0:
            continue
        last = last_time(f)
        if last < since:
            continue
        cwd = src = first = None
        with open(f, encoding="utf-8", errors="ignore") as h:
            for d in jsonl(h):
                p = d.get("payload") or {}
                if d.get("type") == "session_meta" and src is None:  # 첫 meta만(하위 agent 기록엔 부모 meta가 뒤에 붙음)
                    cwd, src = p.get("cwd"), p.get("source")
                    if not isinstance(src, str):  # 하위 agent(subagent)는 제외
                        break
                elif first is None and d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
                    t = text_of(p.get("content"))
                    first = t if is_human(t) else None
                if isinstance(src, str) and first:
                    break
        if not (isinstance(src, str) and first):
            continue
        for nbytes in (1 << 20, 1 << 23, 1 << 26):
            running = last_ai = last_user = None
            lines, more = tail_lines(f, nbytes)
            for d in jsonl(reversed(lines)):
                p = d.get("payload") or {}
                if d.get("type") == "event_msg" and p.get("type") in ("task_started", "task_complete", "turn_aborted"):
                    running = p["type"] in ("task_started", "turn_aborted") if running is None else running
                elif d.get("type") == "response_item" and p.get("type") == "message":
                    t = text_of(p.get("content"))
                    if p.get("role") == "user" and last_user is None and is_human(t):
                        last_user = t
                    elif p.get("role") == "assistant" and last_ai is None and t.strip() and p.get("channel") != "analysis":
                        last_ai = t
                if running is not None and last_ai and last_user:
                    break
            if not more or (running is not None and last_ai and last_user):
                break
        sid = re.search(r"([0-9a-f-]{36})\.jsonl$", f).group(1)
        yield dict(tool="codex", src=src, mtime=last, id=sid, cwd=cwd, title=codex_names().get(sid),
                   first=first, last_user=last_user or first, last_ai=last_ai,
                   state="작업 중 끊김" if running else "답변 후 대기", source=f,
                   **recent_context(lines, "codex", cwd), cmd=f"codex --no-daemon resume {sid}")


def session_labels():
    """바탕화면 'AI Session List.txt'에서 세션 id → 사용자가 붙인 이름. 인수한 새 세션도 첫 질문의 옛 id로 같은 이름을 얻는다."""
    try:
        with open(HOME + "/Desktop/AI Session List.txt", encoding="utf-8") as h:
            text = h.read()
    except OSError:
        return {}
    out = {}
    for line in text.splitlines():
        m = re.search(rf"({UUID})\s+(\S.*)$", line)
        if m:
            out[m.group(1)] = re.split(r"\s{2,}|\t", m.group(2).strip())[0]
    return out


def one_line(t, n):
    return (t or "").replace("\n", " ").strip()[:n]


def user_label(s, labels):
    return labels.get(s["id"]) or next((v for k, v in labels.items() if k in s.get("first", "")), None)


def name_of(s, labels):
    return s.get("name") or s["title"] or user_label(s, labels) or s.get("auto") \
        or one_line(re.sub(UUID, "", s["first"]), 12)


def processes():
    """(claude 프로세스 pid 모음, 'name|시작 시각(초)|명령줄' 줄들). Windows는 PowerShell, Mac은 ps로 읽는다(2026-10-21).
    Mac에서 PowerShell을 부르면 프로그램이 없어 세션 칸 전체가 멈췄다."""
    if WINDOWS:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "  # 명령줄의 한글 첫 질문이 깨지지 않게
                              "(Get-Process claude -ea 0).Id -join ','; "
                              "Get-CimInstance Win32_Process | ? { $_.Name -match '^(codex|node|claude)' } | "
                              "% { '{0}|{1}|{2}' -f $_.Name, ([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds(), $_.CommandLine }"],
                             capture_output=True, text=True, encoding="utf-8", errors="ignore").stdout
        first, _, rest = out.partition("\n")
        return {int(p) for p in first.split(",") if p.strip().isdigit()}, rest
    out = subprocess.run(["ps", "-axww", "-o", "pid=,lstart=,args="], capture_output=True, text=True,
                         errors="ignore", env=dict(os.environ, LC_ALL="C")).stdout
    pids, rows = set(), []
    for line in out.splitlines():
        parts = line.split(None, 6)  # pid, 시작 시각 다섯 칸(Wed Oct 14 10:39:36 2026), 명령줄
        if len(parts) < 7 or not parts[0].isdigit():
            continue
        try:
            start = int(time.mktime(time.strptime(" ".join(parts[1:6]), "%a %b %d %H:%M:%S %Y")))
        except ValueError:
            continue
        name = os.path.basename(parts[6].split()[0])
        if name == "claude":
            pids.add(int(parts[0]))
        if re.match(r"(codex|node|claude)", name):
            rows.append(f"{name}|{start}|{parts[6]}")
    return pids, "\n".join(rows)


def live_ids():
    """지금 실행 중인 세션 id. Claude는 ~/.claude/sessions/<pid>.json(살아 있는 pid만), resume은 Claude·Codex 모두 프로세스 명령줄에서 찾는다.
    Claude resume 탭은 시작 화면에서 멈추면 sessions/<pid>.json이 안 생겨 꺼짐으로 보였다(2026-10-08)."""
    pids, rest = processes()
    ids = set(re.findall(UUID, rest))
    for f in glob.glob(HOME + "/.claude/sessions/*.json"):
        try:
            d = json.load(open(f, encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if d.get("pid") in pids:
            ids.add(d.get("sessionId"))
    return ids | new_codex_ids(rest, ids)


def new_codex_ids(procs, live):
    """새로 시작한(resume 아닌) Codex 탭은 명령줄에 세션 id가 없어 꺼짐으로 보였다(2026-10-08 탭 13개인데 메뉴판 실행 중 10개).
    그 프로세스가 시작한 뒤 처음 생긴 Codex 세션을 그 탭 것으로 본다. Codex id 앞 48비트가 세션을 만든 시각(ms)이다.
    명령줄에 첫 질문이 있으면 그 질문으로 시작한 세션을 먼저 고른다(1초 차로 생긴 두 세션을 시각만으로는 못 가렸다).
    첫 질문 없이 열어 둔 세션도 후보에 넣는다: 빼면 그 탭이 다음 세션(이미 꺼진 것)을 가져가 '실행 중'으로 잘못 보였다(2026-10-12).
    터미널 탭(npm으로 설치한 codex)만 센다: ChatGPT 앱이 띄운 codex·하위 agent 기록(부모_자식 이름)은 뺀다.
    Mac은 프로그램 이름이 codex(.exe 없음), 경로 구분이 /다(2026-10-21)."""
    starts = []
    for line in procs.splitlines():
        name, _, rest = line.partition("|")
        t, _, cmd = rest.partition("|")
        if name.lower() in ("codex.exe", "codex") and t.isdigit() and re.search(r"node_modules[\\/]@openai[\\/]codex", cmd) \
                and not re.search(UUID + r"|app-server|managed-daemon|\bexec\b", cmd):
            starts.append((int(t), " ".join(cmd.split())))
    if not starts:
        return set()
    born = lambda sid: int(sid.replace("-", "")[:12], 16) / 1000
    cands = {}
    for f, m in session_files()["codex"]:
        ids = re.findall(UUID, os.path.basename(f))
        if len(ids) == 1 and ids[0] not in live and born(ids[0]) >= min(starts)[0] - 5:
            cands[ids[0]] = (f, m)
    firsts = {s["id"]: s["first"] for s in codex_sessions(0, files=list(cands.values()))}
    pool = sorted(cands, key=born)
    found = set()
    for t, cmd in sorted(starts):
        after = [sid for sid in pool if born(sid) >= t - 5 and sid not in found]
        hit = next((sid for sid in after if firsts.get(sid) and one_line(firsts[sid], 30) in cmd), after[0] if after else None)
        if hit:
            found.add(hit)
    return found


def anchor(live):
    """마지막으로 끊긴(지금 안 돌고 있는) 세션의 마지막 기록 시각. 주말·연휴 뒤에도 '지금' 대신 이 시각에서 거슬러 올라가야 끊기기 직전 작업이 잡힌다."""
    files = [x for kind in session_files().values() for x in kind]
    best = 0
    for f, mtime in files:
        if mtime < time.time() - STALE:  # 수정 시각이 멈춘 파일이 있어(STALE 주석 참고) 정렬해서 일찍 멈추지 않는다
            continue
        m = re.search(UUID + r"\.jsonl$", f)
        if m and m.group(0)[:-6] not in live and os.path.getsize(f):
            best = max(best, last_time(f))
    return best or time.time()


def read_session(sid):
    """id 하나의 세션 기록을 시간 범위와 상관없이 읽는다(최근 끝낸·킵한 세션 목록용). 기록이 없으면 None."""
    for tool, reader in (("claude", claude_sessions), ("codex", codex_sessions)):
        files = [(f, m) for f, m in session_files()[tool] if f.endswith(sid + ".jsonl")]
        if files:
            return next(reader(0, files=files), None)
    return None


def load_done(kind="done"):
    """사용자가 표시한 세션 {id: 표시한 시각}. done = 끝남(목록에서 숨김), keep = 킵(급하지 않아 나중에 할 것: 목록엔 보이되 '전부 열기'에서 빠짐).
    끝남은 표시 뒤에 대화가 새로 생기면 자동으로 풀린다. 킵은 [풀기](--unkeep)로만 풀린다: 킵 누르고 바로 닫아도 믿을 수 있게(2026-10-12)."""
    try:
        with open(SNAP_DIR + f"/{kind}.json", encoding="utf-8") as h:
            return json.load(h)
    except (OSError, ValueError):
        return {}


def is_done(sid, last, done):
    return sid in done and last <= done[sid] + 120


def collect(since, keep_done=False):
    rows, seen, done, keep = [], set(), load_done(), load_done("keep")
    for s in sorted([*claude_sessions(since), *codex_sessions(since)], key=lambda s: -s["mtime"]):
        if (s["tool"], s["first"]) in seen:  # 갈라진 사본은 최신 것만
            continue
        seen.add((s["tool"], s["first"]))
        if s["first"].startswith(DESK_PROMPT[:30]):  # 복구 데스크 세션 자체는 목록에 안 넣는다
            continue
        s["kept"] = s["id"] in keep
        if keep_done or not is_done(s["id"], s["mtime"], done):
            rows.append(s)
    return rows


def codex_self(window=600):
    """Codex 창에서 번호 없이 $done을 쳤을 때 그 세션 찾기: 최근 window초 안에 사용자 입력에 $done·$끝이 들어 있는 Codex 세션(가장 최근).
    "아니다 널 닫을게 $done"처럼 문장 끝에 붙여도 잡는다(시작만 보다가 못 찾음, 2026-10-08)."""
    now, best = time.time(), None
    for f, mtime in session_files()["codex"]:
        if mtime < now - STALE:
            continue
        lines, _ = tail_lines(f, 1 << 18)
        for d in jsonl(reversed(lines)):
            p = d.get("payload") or {}
            if d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
                t = text_of(p.get("content")).strip()
                if re.search(r"(^|\s)\$(done|끝)\b", t):
                    ts = datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).timestamp()
                    if ts >= now - window and (best is None or ts > best[1]):
                        best = (re.search(r"([0-9a-f-]{36})[.]jsonl$", f).group(1), ts)
                    break
    return best[0] if best else None


def mark_done(args, undo=False, kind="done"):
    """--done [번호,번호|id앞자리]: 끝남 표시(--keep이면 킵 표시). 번호는 최근 --desk가 저장한 latest.json 기준, 비우면 이 세션(CLAUDE_CODE_SESSION_ID)."""
    done = load_done(kind)
    pool = {}
    for name in ("latest.json", "last_opened.json"):
        try:
            for x in json.load(open(SNAP_DIR + "/" + name, encoding="utf-8")):
                pool[x["id"]] = x
        except (OSError, ValueError):
            pass
    for i in done:  # 숨긴 세션은 latest.json에서 빠지므로, 해제할 때는 done.json에서 찾는다
        pool.setdefault(i, {"id": i})
    latest = {x["n"]: x for x in json.load(open(SNAP_DIR + "/latest.json", encoding="utf-8"))} if os.path.exists(SNAP_DIR + "/latest.json") else {}
    picks = []
    for tok in [t for a in args for t in a.split(",") if t]:
        if tok.isdigit() and int(tok) in latest:
            picks.append(latest[int(tok)]["id"])
        else:
            hit = [i for i in pool if i.startswith(tok)]
            # 스냅샷에 없는 세션도 전체 id로는 표시할 수 있다(메모 mod 메뉴판의 세션 칸 [끝] 버튼)
            picks += hit or ([tok] if re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", tok) else [])
    if not picks and not args:  # 번호 없이 치면 지금 이 세션: Claude는 환경변수, Codex는 방금 $done을 친 세션
        me = os.environ.get("CLAUDE_CODE_SESSION_ID") or codex_self()
        picks = [me] if me else []
    if not picks:
        print("대상을 못 찾았습니다. 번호(최근 --desk 목록 기준)나 세션 id 앞자리를 주세요.")
        return
    for sid in picks:
        if undo:
            done.pop(sid, None)
        else:
            done[sid] = time.time()
        word = "끝남" if kind == "done" else "킵"
        print((f"{word} 표시 해제: " if undo else f"{word}으로 표시: ") + (pool.get(sid, {}).get("name") or sid[:8]) + f" ({sid[:8]})")
    os.makedirs(SNAP_DIR, exist_ok=True)
    with open(SNAP_DIR + f"/{kind}.json", "w", encoding="utf-8") as h:
        json.dump(done, h, indent=1)


SNAP_DIR = HOME + "/.claude/scripts/snapshots"
DESK_GUIDANCE = """사용자에게 보여줄 형식: 첫 줄에 실행 중 N개·꺼진 M개. 킵이 아닌 번호는 아래 세 줄로 요약한다.
[번호 · 도구 · 실행 상태] 작업: 프로젝트와 이루려던 목표를 쉬운 말로.
  멈춘 곳: 무엇까지 끝났고 어떤 작업·사용자 답·권한이 남았는지. A/B 선택은 뜻도 함께 쓴다.
  판정: 필요 / 끝난 듯 / 확인 필요 — 짧은 이유.
이름 목록·첫 요청·최근 작업 폴더와 파일·최근 대화를 함께 보고 현재 목표를 복원한다. 오래된 이름·첫 요청보다 최근 작업을 우선한다.
sanul·홈·fix나 '다음 지시 대기', '빌드 오류 확인 중'만으로 작업을 설명하지 않는다. 프로젝트와 실제로 바꾸던 기능을 붙인다.
작업 중 끊김·구체적인 답 대기·완료 후 대기를 구분한다. 마지막 답이 있다는 이유만으로 답 대기라고 하지 않는다.
미완료 작업·검증·필수 결정이 있으면 필요. 요청한 결과와 검증이 끝나고 추가 지시만 기다리면 끝난 듯. 자료가 부족하면 확인 필요.
번호와 새 세션 표시를 유지한다. 실행 상태와 계속 필요한지는 별개다. 테두리 표·고정 폭 열 정렬 대신 자연스럽게 줄바꿈하는 목록으로 쓴다.
판정은 복구 추천일 뿐이다. 세션을 자동으로 열거나 done 처리하지 않고 사용자 선택을 기다린다.
'킵(나중에 할 것)' 표시는 사용자가 급하지 않아 여유 있을 때 하려고 남긴 세션이다. 맨 아래 '킵' 묶음에 한 줄씩만 쓴다: [번호] 이름 · 기다리는 것(사용자 답·회신·남은 작업 하나). 세 줄 요약은 사용자가 그 번호를 물을 때만 쓰고, 고르기 전에는 열자고 권하지 않는다.
사용자가 번호를 고르면 python ~/.claude/scripts/recent_sessions.py --open-desk 1,3 으로 이 목록 번호 그대로 연다(all = 킵 뺀 전부). 다른 시간 범위로 목록을 다시 뽑아 번호를 맞추지 않는다. 열고 나면 출력되는 '열림 확인 N/M'과 안 뜬 탭을 그대로 알린다."""
DESK_PROMPT = (
    "PC just crashed. You are my recovery desk. First read the procedure memory note "
    "~/.claude/projects/C--Users-sanul/memory/reference_recent_sessions_restore.md. "
    "Run: python ~/.claude/scripts/recent_sessions.py --desk 24. "
    "Follow the output guidance printed by the script: in Korean, give each non-kept session three labeled lines "
    "(작업, 멈춘 곳, 판정) with a plain project/task goal, the concrete stopping point, "
    "and 필요 / 끝난 듯 / 확인 필요 with a short reason; give each 킵 session one line at the bottom. "
    "Use the Desktop session labels, first prompt, recent conversation, and touched folders/files together; "
    "recent work takes priority over old titles or old goals. Distinguish interrupted work, a specific unanswered "
    "question, and completed work awaiting optional instructions. Keep the original numbers and new markers. "
    "Use a naturally wrapping list suitable for a narrow terminal. Do not use tables or box-drawing characters. "
    "Do not execute the sessions' tasks, open sessions, or mark them done. Wait for my choice."
)


def remember_opened(chosen, labels):
    """연 세션을 기억해 둔다. 열어만 두고 대화를 안 한 세션은 기록에 흔적이 없어서, 꺼진 뒤 '아까 뭐 열어 놨었지'를 이 목록으로 보충한다."""
    path = SNAP_DIR + "/last_opened.json"
    try:
        old = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        old = []
    now = time.time()
    keep = {x["id"]: x for x in old if now - x["opened"] < 3 * 86400}
    keep.update({s["id"]: dict(id=s["id"], tool=s["tool"], cwd=s["cwd"], name=name_of(s, labels), cmd=s["cmd"], opened=now) for s in chosen})
    os.makedirs(SNAP_DIR, exist_ok=True)
    json.dump(list(keep.values()), open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def desk_data(hours):
    """CLI·메뉴판 공용 read-only 조회. snapshot과 done 번호를 변경하지 않는다."""
    live, labels = live_ids(), session_labels()
    end = anchor(live)
    allrows = collect(end - hours * 3600, keep_done=True)
    done = load_done()
    rows = [s for s in allrows if not is_done(s["id"], s["mtime"], done)]
    ids = {s["id"] for s in allrows}
    try:
        with open(SNAP_DIR + "/last_opened.json", encoding="utf-8") as h:
            opened = json.load(h)
    except (OSError, ValueError):
        opened = []
    extra = [x for x in opened if x["id"] not in ids and x["id"] not in done and time.time() - x["opened"] < 3 * 86400]
    hidden = len(allrows) - len(rows)
    for x in extra:
        files = [(f, mtime) for f, mtime in session_files()[x["tool"]] if f.endswith(x["id"] + ".jsonl")]
        reader = claude_sessions if x["tool"] == "claude" else codex_sessions
        history = next(reader(0, files=files), {})
        rows.append(dict(history, **x, opened_only=True))
    try:
        with open(SNAP_DIR + "/latest.json", encoding="utf-8") as h:
            previous = {x["id"] for x in json.load(h)}
    except (OSError, ValueError):
        previous = None
    keep = load_done("keep")
    # 킵한 세션은 오래돼도 목록에 남긴다: 킵 누르고 바로 닫아도 '여유 있을 때' 찾을 수 있어야 한다(24시간 지나 사라졌다, 2026-10-12)
    have = {s["id"] for s in rows}
    rows += [s for s in map(read_session, (i for i in keep if i not in have and i not in done)) if s]
    for s in rows:
        s["kept"] = s["id"] in keep  # 킵은 [풀기]로만 풀린다(열어만 둔 세션도 킵할 수 있다)
        s["new"] = previous is not None and s["id"] not in previous
        s.setdefault("first", "")
        s.setdefault("title", None)
        s.setdefault("last_user", "")
        s.setdefault("last_ai", "")
        s.setdefault("state", "기록 부족")
    # 최근에 끝낸 세션 5개(시간 범위와 상관없이): 메뉴판 세션 칸에서 눌러 보고 되살린다(2026-10-12 사용자 요청)
    by_id, done_rows = {s["id"]: s for s in allrows}, []
    for sid, _ in sorted(done.items(), key=lambda kv: -kv[1]):
        s = by_id.get(sid) or read_session(sid)
        if s and is_done(sid, s["mtime"], done):  # 끝낸 뒤 다시 대화한 세션은 이미 목록에 돌아와 있다
            done_rows.append(s)
        if len(done_rows) == 5:
            break
    return dict(end=end, live=live, labels=labels, rows=rows, extra=len(extra), hidden=hidden, done_rows=done_rows)


def desk_details(s, labels):
    """이름·현재 목표·중단 지점 판단에 필요한 원문 근거. 의미 판정은 desk의 AI가 한다."""
    return dict(user_name=user_label(s, labels), first=excerpt(s.get("first")),
                last_user=excerpt(s.get("last_user")), last_ai=excerpt(s.get("last_ai"), 1800),
                recent=s.get("recent", []), files=s.get("files", []), changed_files=s.get("changed_files", []),
                dirs=s.get("dirs", []), source=s.get("source"), new=s.get("new", False))


def desk(hours, save=True):
    """복구 desk. save=False는 snapshot을 쓰지 않고 같은 근거를 확인한다."""
    data = desk_data(hours)
    live, labels, rows = data["live"], data["labels"], data["rows"]
    if data["hidden"]:
        print(f"(끝남으로 표시해 숨긴 세션 {data['hidden']}개 — 다시 보려면 --undone 번호나 id)")
    fmt = lambda t: time.strftime("%m-%d %H:%M", time.localtime(t))
    print(f"기준: 마지막으로 끊긴 시각 {fmt(data['end'])} | {hours:g}시간 안 대화 {len(rows) - data['extra']}개 + 열어 뒀던 세션 {data['extra']}개")
    print(DESK_GUIDANCE)
    print("새 Codex 세션은 실행 중이어도 꺼짐으로 보일 수 있습니다.")
    if not save:
        print("미리보기: 번호는 미리보기용이며 저장된 번호 목록을 갱신하지 않습니다.")
    snap = []
    for s in rows:
        n = len(snap) + 1
        last = "열어 둠 " + fmt(s["opened"]) if s.get("opened_only") else fmt(s["mtime"])
        details = desk_details(s, labels)
        print(f"\n[{n}] {s['tool']} · {'● 실행 중' if s['id'] in live else '○ 꺼짐'} · {last}" + (" · 새 세션" if s["new"] else "")
              + (" · 킵(나중에 할 것)" if s.get("kept") else ""))
        print(f"    이름: {name_of(s, labels)}" + (f" / 사용자 이름: {details['user_name']}" if details["user_name"] else ""))
        print(f"    시작 폴더: {s['cwd']}")
        print(f"    기록상 상태: {s['state']}")
        print(f"    첫 요청: {details['first'] or '(기록 없음)'}")
        for key, title in (("dirs", "최근 작업 폴더"), ("changed_files", "최근 변경 파일"), ("files", "최근 경로 단서")):
            if details[key]:
                print(f"    {title}: " + " / ".join(details[key]))
        for item in details["recent"]:
            print(f"    {'사용자' if item['role'] == 'user' else 'AI'}: {item['text']}")
        if not details["recent"]:
            print("    최근 대화 기록 없음 — 이름·열어 둔 사실만으로 완료를 판정하지 않습니다.")
        if details["source"]:
            print(f"    근거 파일: {details['source']}")
        snap.append(dict(n=n, tool=s["tool"], id=s["id"], cwd=s["cwd"], name=name_of(s, labels), cmd=s["cmd"], last=last,
                         last_user=one_line(s["last_user"], 40), was_running=s["id"] in live, kept=s.get("kept", False)))
    if save:
        os.makedirs(SNAP_DIR, exist_ok=True)
        with open(SNAP_DIR + "/latest.json", "w", encoding="utf-8") as h:
            json.dump(snap, h, ensure_ascii=False, indent=1)
        print(f"\n저장: {SNAP_DIR}/latest.json")


def open_desk(pick):
    """최근 --desk가 저장한 번호 그대로 연다. 6시간 목록을 새로 뽑아 번호를 맞추면 순서가 달라 엉뚱한 세션이 열릴 수 있었다(2026-10-13)."""
    path = SNAP_DIR + "/latest.json"
    try:
        snap = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        print("데스크 목록이 없습니다. 먼저 --desk 24를 실행하세요.")
        return
    by_n = {x["n"]: x for x in snap}
    try:
        chosen = [x for x in snap if not x.get("kept")] if pick == "all" else [by_n[int(n)] for n in pick.split(",")]
    except (ValueError, KeyError):
        print("번호를 확인해 주세요. 번호는 최근 --desk 목록 기준입니다.")
        return
    print(f"데스크 목록 기준: {time.strftime('%m-%d %H:%M', time.localtime(os.path.getmtime(path)))} 저장")
    open_tabs([dict(x, title=x["name"], first="") for x in chosen], live_ids(), session_labels(), confirm=True)


def open_id(sid):
    """메뉴판 세션 칸 [열기]: id 하나를 시간 범위·킵과 상관없이 찾아 새 탭으로 연다.
    킵한 서약서 세션을 다시 열 길이 복구 데스크뿐이고, 거기선 '전부 열기'에서 빠져 ID를 찾아 쳐야 했다(2026-10-13)."""
    s = read_session(sid) if re.fullmatch(UUID, sid) else None
    if not s:
        print(f"세션 기록을 못 찾음: {sid}")
        return
    open_tabs([s], live_ids(), session_labels())


def confirm_opened(chosen, labels, since, wait=40):
    """연 탭이 실제로 떴는지 본다. Claude는 대화를 불러온 뒤 생기는 sessions/<pid>.json, Codex는 프로세스 명령줄의 id.
    시작 화면에서 멈춘 Claude 탭(2026-10-08), Codex 없이 빈 명령 프롬프트만 남은 탭(2026-10-11)을 바로 알리려는 것."""
    left, live = list(chosen), set()
    while left and time.time() - since < wait:
        time.sleep(3)
        live, loaded = live_ids(), set()
        for f in glob.glob(HOME + "/.claude/sessions/*.json"):
            try:
                d = json.load(open(f, encoding="utf-8"))
            except (ValueError, OSError):
                continue
            if d.get("startedAt", 0) >= since * 1000:
                loaded.add(d.get("sessionId"))
        left = [s for s in left if s["id"] not in live or (s["tool"] == "claude" and s["id"] not in loaded)]
    print(f"열림 확인: {len(chosen) - len(left)}/{len(chosen)} 실행 중")
    for s in left:
        why = "프로세스 없음, 탭의 오류 메시지 확인" if s["id"] not in live else "시작 화면에서 멈춤, 탭에서 확인 창·Enter 확인"
        print(f"  안 뜸: {name_of(s, labels)} ({s['tool']}) · {why}")


def open_tabs(chosen, live, labels, confirm=False):
    """새 Windows Terminal 창에 탭으로 연다. (연 개수, 건너뛴 이름들)을 돌려준다. confirm이면 실제로 떴는지까지 본다(CLI만, 브라우저 화면은 안 기다림)."""
    # 이미 열려 있는 세션을 또 열면 같은 대화를 두 프로세스가 건드린다(2026-10-02 시험 중 실제로 중복 탭이 생김).
    skipped = [name_of(s, labels) for s in chosen if s["id"] in live]
    for name in skipped:
        print(f"이미 열려 있어 건너뜀: {name}")
    chosen = [s for s in chosen if s["id"] not in live]
    if not chosen:
        print("\n열 세션이 없습니다. +24처럼 시간을 늘려 보세요.")
        return 0, skipped
    if not WINDOWS:
        return open_mac(chosen, labels, confirm), skipped
    wt = ["wt", "-w", "restore"]
    for s in chosen:
        # 사용자가 평소 쓰는 '명령 프롬프트' 프로필로 연다(PowerShell 탭은 싫어함, 2026-10-02).
        # --title은 처음 이름일 뿐: 고정 옵션(--suppressApplicationTitle)을 빼서 /rename·자동 제목을 따라가게 한다(2026-10-12 사용자 결정, 탭 이름 = 세션 이름)
        wt += ["nt", "-p", CMD_PROFILE, "--title", name_of(s, labels), "-d", s["cwd"],
               "cmd", "/k", s["cmd"], ";"]
    # Claude 안에서 실행하면 CLAUDE_CODE_CHILD_SESSION 등이 새 탭으로 넘어가 대화가 저장되지 않는다(2026-10-02 확인).
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE") or k == "CLAUDE_CODE_GIT_BASH_PATH"}
    since = time.time()
    subprocess.Popen(wt[:-1], env=env)
    remember_opened(chosen, labels)
    print(f"\n{len(chosen)}개 탭을 새 Windows Terminal 창으로 열었습니다.", flush=True)
    if confirm:
        confirm_opened(chosen, labels, since)
    return len(chosen), skipped


def open_mac(chosen, labels, confirm=False):
    """Mac(2026-10-21): Orca 안에서 부르면 Orca 새 탭(그 세션 폴더의 작업 공간, 없으면 지금 보는 곳)에, 아니면 터미널(Terminal.app) 새 창에 연다.
    새 탭의 셸은 Orca·터미널이 띄우므로 이 프로세스의 CLAUDE_* 환경변수가 넘어가지 않는다(넘어가면 대화가 저장되지 않는다). 연 개수를 돌려준다."""
    orca = os.path.join(os.environ.get("ORCA_CLI_BIN_DIR") or os.path.dirname(ORCA), "orca")
    in_orca = os.environ.get("TERM_PROGRAM") == "Orca" and os.path.exists(orca)
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
    since, opened = time.time(), []
    for s in chosen:
        line = f"cd {shlex.quote(s.get('cwd') or HOME)} && {s['cmd']}"
        try:
            if in_orca:
                ok = any(subprocess.run([orca, "terminal", "create", "--worktree", where, "--command", line, "--json"],
                                        capture_output=True, text=True, env=env, timeout=30).returncode == 0
                         for where in (f"path:{s.get('cwd') or HOME}", "active"))
            else:
                script = os.path.join(tempfile.mkdtemp(prefix="memo-open-"), "open.command")
                with open(script, "w", encoding="utf-8") as h:
                    h.write(f"#!/bin/zsh -l\n{line}\n")
                os.chmod(script, 0o755)
                ok = subprocess.run(["open", "-a", "Terminal", script], env=env, timeout=30).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            ok = False
        if ok:
            opened.append(s)
        else:
            print(f"열지 못함: {name_of(s, labels)}")
    if opened:
        remember_opened(opened, labels)
        print(f"\n{len(opened)}개 세션을 {'Orca 새 탭' if in_orca else '터미널 새 창'}으로 열었습니다.", flush=True)
        if confirm:
            confirm_opened(opened, labels, since)
    return len(opened)


def row_json(s, live, labels):
    home = os.path.normcase(HOME)
    cwd = os.path.normcase(s["cwd"].rstrip("\\/"))
    ws = "홈" if cwd == home else os.path.basename(s["cwd"].rstrip("\\/")) or s["cwd"]
    return dict(id=s["id"], tool=s["tool"], name=name_of(s, labels), ws=ws, cwd=s["cwd"], mtime=s["mtime"],
                state=s["state"], live=s["id"] in live, last_user=one_line(s["last_user"], 140), last_ai=one_line(s["last_ai"], 400))


def serve(open_browser=True):
    """브라우저 화면. 127.0.0.1에서만 열고, 열기 요청은 화면에 심은 일회용 토큰이 있어야 받는다."""
    import http.server, secrets, webbrowser
    from urllib.parse import parse_qs, urlparse
    token = secrets.token_hex(8)
    st = dict(by_id={}, labels={})

    def scan(days):
        live, labels = live_ids(), session_labels()
        end = anchor(live)
        rows = collect(end - days * 86400)
        st["by_id"].update({s["id"]: s for s in rows})  # 열기 요청은 지금까지 읽은 모든 세션에서 찾는다
        st.update(labels=labels)
        return live, end, rows

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, code, body, ctype="application/json; charset=utf-8"):
            b = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b)

        def local(self):  # 다른 사이트가 주소를 바꿔 치기해 부르는 것(DNS rebinding)을 막는다
            return self.headers.get("Host", "").split(":")[0] in ("127.0.0.1", "localhost")

        def do_GET(self):
            if not self.local():
                return self.reply(403, "{}")
            if self.path == "/":
                page = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "session_viewer.html"), encoding="utf-8").read()
                return self.reply(200, page.replace("__TOKEN__", token), "text/html; charset=utf-8")
            url = urlparse(self.path)
            if url.path == "/api/sessions":
                days = min(int((parse_qs(url.query).get("days") or ["7"])[0]), 365)
                live, end, rows = scan(days)
                data = dict(anchor=end, days=days, rows=[row_json(s, live, st["labels"]) for s in rows])
                return self.reply(200, json.dumps(data, ensure_ascii=False))
            self.reply(404, "{}")

        def do_POST(self):
            if not self.local() or self.headers.get("X-Token") != token or self.path != "/api/open":
                return self.reply(403, "{}")
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            chosen = [st["by_id"][i] for i in body.get("ids", []) if i in st["by_id"]]
            opened, skipped = open_tabs(chosen, live_ids(), st["labels"])
            self.reply(200, json.dumps(dict(opened=opened, skipped=skipped), ensure_ascii=False))

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)  # 1개월치를 읽는 동안에도 '열기' 요청을 받는다
    url = f"http://127.0.0.1:{srv.server_address[1]}/"
    print(f"AI 세션 복구 화면: {url}\n(이 창을 닫으면 화면도 멈춥니다)", flush=True)
    if open_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # PYTHONUTF8 없이 부르면 cp949로 나가 '—'에서 멈췄다(2026-10-08)
    args = sys.argv[1:]
    if "--serve" in args:
        return serve("--no-browser" not in args)
    for flag in ("--done", "--undone", "--keep", "--unkeep"):
        if flag in args:
            return mark_done(args[args.index(flag) + 1:], undo=flag.startswith("--un"), kind="keep" if "keep" in flag else "done")
    if "--open-id" in args:
        return open_id(next(iter(args[args.index("--open-id") + 1:]), ""))
    if "--open-desk" in args:
        return open_desk(next(iter(args[args.index("--open-desk") + 1:]), ""))
    if "--desk" in args or "--desk-preview" in args:
        nums = [a for a in args if a.replace(".", "").isdigit()]
        return desk(float(nums[0]) if nums else 24, save="--desk-preview" not in args)
    hours = float(args[0]) if args and args[0].replace(".", "").isdigit() else 6
    ask = "--ask" in args
    pick = args[args.index("--open") + 1] if "--open" in args else None
    live, labels = live_ids(), session_labels()
    if "--from" in args:  # 저장해 둔 스냅샷 그대로 열기
        snap = json.load(open(args[args.index("--from") + 1], encoding="utf-8"))
        open_tabs([dict(x, title=x["name"], first="") for x in snap], live, labels, confirm=True)
        return
    end = anchor(live)
    while True:
        print(f"세션 기록 읽는 중... ({hours:g}시간 범위)", flush=True)
        rows = collect(end - hours * 3600)
        print(f"\n기준: 마지막으로 끊긴 시각 {time.strftime('%m-%d %H:%M', time.localtime(end))}에서 {hours:g}시간 전까지 - {len(rows)}개\n")
        for i, s in enumerate(rows, 1):
            when = time.strftime("%m-%d %H:%M", time.localtime(s["mtime"]))
            mark = ("  <- 실행 중" if s["id"] in live else "") + ("  [킵]" if s.get("kept") else "")
            if ask:
                print(f"[{i:>2}] {when} {s['tool']:<6} {name_of(s, labels)[:18]} - {one_line(s['last_user'], 34)}{mark}")
                continue
            print(f"[{i}] {when} {s['tool']}({s['src']}) {s['state']}  {s['title'] or ''}{mark}")
            print(f"    폴더: {s['cwd']}")
            print(f"    처음: {one_line(s['first'], 90)}")
            print(f"    마지막 질문: {one_line(s['last_user'], 90)}")
            print(f"    마지막 답: {one_line(s['last_ai'], 120)}")
            print(f"    다시 열기: cd \"{s['cwd']}\"; {s['cmd']}")
        if not ask:
            break
        try:
            ans = input("\n번호(예 1,3) / Enter=전부(킵 제외) / +24=24시간 더 거슬러 보기 / q=취소 > ").strip().lower()
        except EOFError:
            return
        if ans.startswith("+") and ans[1:].replace(".", "").isdigit():
            hours += float(ans[1:])
            continue
        if ans == "q":
            return
        pick = "all" if ans in ("", "a", "all") else ans
        break
    if not pick:
        return
    try:
        chosen = [s for s in rows if not s.get("kept")] if pick == "all" else [rows[int(n) - 1] for n in pick.split(",")]
    except (ValueError, IndexError):
        print("번호를 확인해 주세요.")
        return
    open_tabs(chosen, live, labels, confirm=True)


if __name__ == "__main__":
    main()
