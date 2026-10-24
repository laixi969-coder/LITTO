#!/usr/bin/env python3
"""五板块提示词结构校验。

只查可以机械判定的部分：标题、时间码、否定词、资产引用。
画面是否成立、动作是否可拍，仍由技能第 10 节逐项自问。

用法：
    python3 checkPrompt.py prompt.md
    cat prompt.md | python3 checkPrompt.py

退出码 0 = 通过；1 = 有 error（结构错）；仅 warning 时仍返回 0。
"""

import re
import sys

TITLES = [
    "【故事前提与资产绑定】",
    "【画面质感与光影】",
    "【镜头与动作时间线】",
    "【对白、环境声与BGM】",
    "【负面提示词】",
]

# 禁止当作顶级标题使用的写法（技能内明确列过）
FORBIDDEN = ["【素材职责】", "【人物】", "【视觉风格】", "【声音】", "【镜头】", "【正文】"]

# 只匹配明确否定，避免"不动""不断"这类正常表达误报
NEGATIONS = ["不出现", "不要", "没有", "禁止", "避免", "不得", "不能", "勿", "别让", "不应", "不许"]

SHOT_RE = re.compile(
    r"【镜头\s*(\d+)\s*[｜|]\s*(\d+(?:\.\d+)?)\s*秒\s*[–\-—~至到]\s*(\d+(?:\.\d+)?)\s*秒[^】]*】"
)
DURATION_RE = re.compile(r"总时长[：:]\s*(\d+(?:\.\d+)?)\s*秒")
ASSET_RE = re.compile(r"@[\u4e00-\u9fa5A-Za-z0-9_]+")


def split_blocks(text):
    """按顶级标题切块，返回 {标题: 正文}；标题缺失时为 None。"""
    positions = []
    for title in TITLES:
        found = [m.start() for m in re.finditer(re.escape(title), text)]
        positions.append((title, found))
    blocks = {}
    for index, (title, found) in enumerate(positions):
        if not found:
            blocks[title] = None
            continue
        start = found[0] + len(title)
        end = len(text)
        for other_title, other_found in positions:
            if other_title == title:
                continue
            later = [pos for pos in other_found if pos > start]
            if later:
                end = min(end, min(later))
        blocks[title] = text[start:end]
    return blocks


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as handle:
            text = handle.read()
    else:
        text = sys.stdin.read()

    errors, warnings = [], []

    # 1. 五个标题各一次、顺序正确
    positions = {}
    for title in TITLES:
        count = text.count(title)
        if count == 0:
            errors.append("缺少标题 %s" % title)
        elif count > 1:
            errors.append("标题 %s 出现 %d 次，必须只出现一次" % (title, count))
        else:
            positions[title] = text.index(title)
    ordered = [positions[title] for title in TITLES if title in positions]
    if len(ordered) == len(TITLES) and ordered != sorted(ordered):
        errors.append("五个标题顺序不对，必须是：" + " → ".join(TITLES))

    # 2. 禁止的顶级标题
    for word in FORBIDDEN:
        if word in text:
            errors.append("出现禁止的顶级标题 %s，其内容应并入对应板块" % word)

    # 3. 时间线：子标题、时间码连续、总和等于总时长
    timeline = split_blocks(text).get(TITLES[2]) or ""
    shots = SHOT_RE.findall(timeline)
    declared = DURATION_RE.search(text)
    if not shots:
        if timeline.strip():
            errors.append("【镜头与动作时间线】里没有【镜头NN｜a秒–b秒｜…】子标题")
    else:
        cursor = 0.0
        for number, start_text, end_text in shots:
            start, end = float(start_text), float(end_text)
            if start > cursor:
                errors.append("镜头 %s 起点 %.2f 秒，与上一镜结束 %.2f 秒之间有空隙" % (number, start, cursor))
            elif start < cursor:
                errors.append("镜头 %s 起点 %.2f 秒，与上一镜结束 %.2f 秒重叠" % (number, start, cursor))
            if end <= start:
                errors.append("镜头 %s 结束 %.2f 秒不晚于起点 %.2f 秒" % (number, end, start))
            cursor = end
        if declared:
            total = float(declared.group(1))
            if abs(cursor - total) > 0.05:
                errors.append("镜头总时长 %.2f 秒，与声明的总时长 %.2f 秒不一致" % (cursor, total))
        elif abs(cursor) > 0:
            warnings.append("没有找到「总时长：N 秒」，无法核对时间线总和（当前合计 %.2f 秒）" % cursor)

    # 4. 时间线正文的否定表达
    for line in timeline.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("【镜头"):
            continue
        for word in NEGATIONS:
            if word in stripped:
                errors.append("时间线正文出现否定表达「%s」，改为正向描述，负面约束移到【负面提示词】：%s" % (word, stripped[:40]))
                break

    # 5. 资产引用
    assets = ASSET_RE.findall(split_blocks(text).get(TITLES[0]) or "")
    if not assets:
        errors.append("【故事前提与资产绑定】里没有 @ 资产引用")

    # 6. 板块不能空
    for title, body in split_blocks(text).items():
        if body is not None and not body.strip():
            errors.append("%s 下没有内容" % title)

    for item in errors:
        print("ERROR  " + item)
    for item in warnings:
        print("WARN   " + item)
    if not errors and not warnings:
        print("PASS   五个标题齐、时间码连续、正文正向、资产引用存在")
    elif not errors:
        print("PASS   结构通过（有 %d 条提醒）" % len(warnings))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
