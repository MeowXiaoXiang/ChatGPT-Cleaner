#!/usr/bin/env python3
"""
convert-icons.py
用途：
    將 chat-icon.svg 轉成 16/48/128 三種尺寸的 PNG icon。
需求：
    - Python 3
    - cairosvg (pip install cairosvg)
    - 系統需安裝 cairo (Windows 請裝 GTK, Linux/macOS 請用套件管理安裝 cairo)
"""

import os, sys

try:
    import cairosvg
except OSError as e:
    print("Cairo library 未安裝或找不到 (libcairo / cairo.dll)")
    print("Windows → 請安裝 GTK runtime")
    print("Linux  → apt install libcairo2")
    print("macOS  → brew install cairo")
    sys.exit(1)
except ImportError:
    print("需安裝 cairosvg: pip install cairosvg")
    sys.exit(1)

# 自己想要的尺寸自己加 OwO
sizes = [16, 48, 128, 300]
svg_file = os.path.join(os.path.dirname(__file__), "chat-icon.svg")

if not os.path.exists(svg_file):
    print(f"無法取得 {svg_file}")
    sys.exit(1)

for size in sizes:
    out_file = f"chat-icon-{size}.png"
    cairosvg.svg2png(
        url=svg_file, write_to=out_file, output_width=size, output_height=size
    )
    print(f"已轉換: {out_file}")
