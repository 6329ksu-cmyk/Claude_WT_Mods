"""Codex 스킬 목록($)에 한국어 설명이 보이게 한다.

SKILL.md 앞머리의 metadata.short-description(화면에만 보이는 설명)을 한국어로 채운다.
모델이 읽는 description은 건드리지 않는다. 번역은 slash-ko mod의 사전
(~/.claude/mods/slash-ko-data.json)을 쓰고, 없는 것만 `claude -p`(haiku)로 번역해 사전에 더한다.
스킬이 업데이트돼 영어로 돌아가면 다시 돌리면 된다. 처음 고치는 파일은 원본을 _backup에 남긴다.

  python codex_ko.py          적용
  python codex_ko.py --dry    바꿀 것만 보기
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

HOME = Path.home()
ROOTS = [HOME / '.codex' / 'skills', HOME / '.agents' / 'skills']
DATA = HOME / '.claude' / 'mods' / 'slash-ko-data.json'
BACKUP = HOME / '.claude' / 'mods' / '_backup' / 'codex-skills-before-ko'
HANGUL = re.compile('[가-힣]')
FRONT = re.compile(r'(---\r?\n)(.*?)(\r?\n---)', re.S)

ASK = """Claude Code 슬래시(/) 메뉴에 뜰 명령 설명을 한국어로 옮긴다.
- 명령마다 한 줄, 40자 안팎. 길면 무엇을 하는지만 남기고 줄인다.
- 기술 용어·제품명(PR, MCP, hook, Git, Chrome 등)은 영어 그대로 둔다.
- 마침표 없이 "~하기"·명사형으로 짧게.
- 입력의 키를 그대로 쓴 JSON 객체 하나만 답한다: {"명령": "설명"}

"""


def skill_files():
    for root in ROOTS:
        yield from sorted(root.glob('*/SKILL.md'))
        yield from sorted(root.glob('.system/*/SKILL.md'))


def lookup(data, name, desc):
    if name in data:
        return data[name]['ko']
    for key, v in data.items():  # 플러그인 스킬은 Claude 쪽 이름이 "플러그인:이름". 같은 스킬일 때만 빌린다
        if key.endswith(':' + name) and v['en'].strip() == desc.strip():
            return v['ko']
    return None


def translate(items):
    claude = shutil.which('claude')
    if not claude or not items:
        return {}
    r = subprocess.run([claude, '-p', '--model', 'haiku'], input=ASK + json.dumps(items, ensure_ascii=False, indent=1),
                       capture_output=True, text=True, encoding='utf-8', timeout=300)
    m = re.search(r'\{.*\}', r.stdout, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}


def with_short(head, ko):
    """앞머리 글에 metadata.short-description 한 줄만 넣거나 바꾼다. 나머지 줄은 그대로."""
    nl = '\r\n' if '\r\n' in head else '\n'
    lines = head.split(nl)
    val = json.dumps(ko, ensure_ascii=False)  # JSON 문자열은 YAML 큰따옴표 문자열로도 맞다
    i = next((k for k, line in enumerate(lines) if re.match(r'metadata:\s*$', line)), None)
    if i is None:
        lines += ['metadata:', f'  short-description: {val}']
        return nl.join(lines)
    indent = '  '
    j = i + 1
    while j < len(lines) and (lines[j][:1] in (' ', '\t') or not lines[j].strip()):
        if lines[j].strip():
            indent = re.match(r'\s*', lines[j]).group(0)
            if lines[j].strip().startswith('short-description:'):
                lines[j] = f'{indent}short-description: {val}'
                return nl.join(lines)
        j += 1
    lines.insert(i + 1, f'{indent}short-description: {val}')
    return nl.join(lines)


def main():
    dry = '--dry' in sys.argv
    data = json.loads(DATA.read_text(encoding='utf-8')) if DATA.exists() else {}
    found = []
    for f in skill_files():
        with f.open(encoding='utf-8', newline='') as fh:  # 줄바꿈(CRLF/LF)을 그대로 둔다
            text = fh.read()
        m = FRONT.match(text)
        try:
            meta = yaml.safe_load(m.group(2) + '\n') if m else None  # 끝 줄바꿈까지 넣어야 Codex가 읽는 값과 같다
        except yaml.YAMLError:
            meta = None
        if not isinstance(meta, dict):
            continue
        name, desc = str(meta.get('name') or f.parent.name), str(meta.get('description') or '')
        if not desc or HANGUL.search(desc):
            continue
        found.append((f, text, m, meta, name, desc))

    missing = {name: desc[:500] for _, _, _, _, name, desc in found if not lookup(data, name, desc)}
    if missing and not dry:
        got = translate(missing)
        fresh = json.loads(DATA.read_text(encoding='utf-8')) if DATA.exists() else {}
        for name, ko in got.items():
            if name in missing and isinstance(ko, str) and ko.strip():
                fresh[name] = {'en': missing[name], 'ko': ko.strip()}
        DATA.write_text(json.dumps(fresh, ensure_ascii=False, indent=2), encoding='utf-8')
        data = fresh

    changed, skipped = [], []
    for f, text, m, meta, name, desc in found:
        ko = lookup(data, name, desc)
        old = (meta.get('metadata') or {}).get('short-description') if isinstance(meta.get('metadata'), dict) else None
        if not ko or old == ko:
            if not ko:
                skipped.append(f'{name} (번역 없음)')
            continue
        head = with_short(m.group(2), ko)
        check = yaml.safe_load(head + '\n') or {}
        if check.get('description') != meta.get('description') or (check.get('metadata') or {}).get('short-description') != ko:
            skipped.append(f'{name} (앞머리 모양이 달라 안 건드림)')
            continue
        changed.append(f'{name:28} {ko}')
        if dry:
            continue
        backup = BACKUP / f.relative_to(HOME)
        if not backup.exists():
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, backup)
        f.write_text(text[:m.start(2)] + head + text[m.end(2):], encoding='utf-8', newline='')

    print(f"{'바꿀 것' if dry else '바꿈'} {len(changed)}개")
    print('\n'.join(changed))
    if dry and missing:
        print(f'\n번역 새로 필요 {len(missing)}개: {", ".join(missing)}')
    if skipped:
        print(f'\n건너뜀 {len(skipped)}개: {", ".join(skipped)}')


if __name__ == '__main__':
    main()
