#!/usr/bin/env python3
"""Render the space-harness demo video from REAL CLI output.

Nothing here is typed by hand: the script runs `init` and `verify` against a
throwaway config dir, captures what the CLI actually prints, and draws that.
The only cosmetic edit is replacing the random tmp path with
~/.config/opencode so the frames stay readable.
"""
import os
import re
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # docs/demo/render.py -> repo root
ROOT = REPO
BIN = ["node", os.path.join(ROOT, "bin", "oc-harness.mjs")]
W, H = 1280, 720
FPS = 15
FONT = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 22)
LINE_H = 34
TOP = 40
LEFT = 48
BG = (13, 17, 23)
WHITE = (230, 237, 243)
GREEN = (63, 185, 80)
DIM = (139, 148, 158)
YELLOW = (210, 153, 34)
RED = (248, 81, 73)

ANSI = re.compile(r"\x1b\[(\d+)m")


def run_clip(args, cfg):
    env = dict(os.environ, OPENCODE_CONFIG_DIR=cfg)
    p = subprocess.run(BIN + args, capture_output=True, text=True, env=env, cwd=ROOT)
    assert p.returncode == 0, p.stderr[-2000:]
    out = (p.stdout + p.stderr).replace(cfg, "~/.config/opencode")
    return [ln.rstrip() for ln in out.splitlines()]


def spans(line):
    """Split an ANSI-coloured line into (text, colour) runs."""
    runs, cur, buf = [], WHITE, ""
    pos = 0
    for m in ANSI.finditer(line):
        if m.start() > pos:
            buf += line[pos : m.start()]
        code = m.group(1)
        if buf:
            runs.append((buf, cur))
            buf = ""
        cur = {"0": WHITE, "1": WHITE, "2": DIM, "31": RED, "32": GREEN, "33": YELLOW}.get(code, WHITE)
        pos = m.end()
    if pos < len(line):
        buf += line[pos:]
    if buf:
        runs.append((buf, cur))
    return runs or [("", WHITE)]


def draw_terminal(draw, lines, prompt="$ "):
    draw.rectangle([0, 0, W, H], fill=BG)
    maxl = (H - TOP) // LINE_H
    if len(lines) > maxl:
        head = [lines[0]] if lines[0][0] == "cmd" else []
        lines = head + [ln for ln in lines if ln[0] != "cmd"][-(maxl - len(head)) :]
    y = TOP
    for kind, payload in lines:
        if y > H - LINE_H:
            break
        if kind == "cmd":
            draw.text((LEFT, y), prompt, font=FONT, fill=GREEN)
            x = LEFT + draw.textlength(prompt, font=FONT)
            for text, colour in spans(payload):
                draw.text((x, y), text, font=FONT, fill=colour)
                x += draw.textlength(text, font=FONT)
        elif kind == "card":
            text, colour = payload
            draw.text((LEFT, y), text, font=FONT, fill=colour)
        else:
            x = LEFT
            for text, colour in spans(payload):
                draw.text((x, y), text, font=FONT, fill=colour)
                x += draw.textlength(text, font=FONT)
        y += LINE_H


def frames_for_command(cmd, output):
    frames = []
    typed = ""
    for ch in cmd:
        typed += ch
        frames.append([("cmd", typed)])
    for i in range(0, len(output), 2):
        frames.append([("cmd", cmd)] + [("out", ln) for ln in output[: i + 2]])
    full = [("cmd", cmd)] + [("out", ln) for ln in output]
    frames.extend([full] * (2 * FPS))
    return frames


def card(lines, hold=2):
    return [[("card", ln) for ln in lines]] * (hold * FPS)


def main(out_dir):
    cfg = tempfile.mkdtemp(prefix="demo-")
    init_out = run_clip(["init", "--profile", "space-bunny-free", "--yes"], cfg)
    verify_out = run_clip(["verify"], cfg)
    seq = []
    seq += card([(("space-harness", WHITE)), (("one command from zero to working", DIM))], hold=2)
    seq += frames_for_command("npx -y opencode-harness-kit init", [l for l in init_out if l.strip()])
    seq += frames_for_command("oc-harness verify", [l for l in verify_out if l.strip()])
    seq += card(
        [
            (("done. restart opencode, then ask it something", GREEN)),
            (("github.com/crytobot459/space-harness", WHITE)),
            (("free models. verified setup.", DIM)),
        ],
        hold=3,
    )
    os.makedirs(out_dir, exist_ok=True)
    frame_dir = tempfile.mkdtemp(prefix="frames-")
    for i, lines in enumerate(seq):
        flat = []
        for kind, payload in lines:
            flat.append((kind, payload))
        img = Image.new("RGB", (W, H), BG)
        draw_terminal(ImageDraw.Draw(img), flat)
        img.save(os.path.join(frame_dir, f"f{i:04d}.png"))
    mp4 = os.path.join(out_dir, "demo.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-i", os.path.join(frame_dir, "f%04d.png"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", mp4], check=True)
    gif = os.path.join(out_dir, "demo.gif")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-framerate", "10", "-i", os.path.join(frame_dir, "f%04d.png"),
         "-vf", "scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse",
         gif], check=True)
    print(f"wrote {mp4} ({os.path.getsize(mp4)//1024}KB) and {gif} ({os.path.getsize(gif)//1024}KB)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "demo"))
