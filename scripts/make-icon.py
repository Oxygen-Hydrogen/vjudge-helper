"""生成扩展图标（media/icon.png）。

用法：python scripts/make-icon.py
需要 Pillow：pip install pillow
"""

import os

from PIL import Image, ImageDraw, ImageFilter

SIZE = 128
SS = 4  # 超采样倍数，缩小后边缘更干净
W = SIZE * SS


def lerp(a, b, t):
    return int(round(a + (b - a) * t))


def main():
    # 背景渐变：深蓝 -> 青
    top = (29, 78, 216)
    bottom = (13, 148, 136)
    grad = Image.new("RGB", (W, W))
    px = grad.load()
    for y in range(W):
        t = y / (W - 1)
        color = (lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t))
        for x in range(W):
            px[x, y] = color

    # 圆角矩形遮罩
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.23), fill=255)

    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    # 高光：左上角一层很淡的白色径向光
    glow = Image.new("L", (W, W), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([int(-W * 0.35), int(-W * 0.45), int(W * 0.85), int(W * 0.55)], fill=46)
    glow = glow.filter(ImageFilter.GaussianBlur(W * 0.09))
    img.paste(Image.new("RGBA", (W, W), (255, 255, 255, 255)), (0, 0), glow)

    # 白色 V 字：两段粗线 + 圆头圆角
    d = ImageDraw.Draw(img)
    stroke = int(W * 0.085)
    pts = [(int(W * 0.255), int(W * 0.285)), (int(W * 0.42), int(W * 0.72)), (int(W * 0.585), int(W * 0.285))]
    d.line(pts, fill=(255, 255, 255, 255), width=stroke, joint="curve")
    for p in (pts[0], pts[2]):
        r = stroke / 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(255, 255, 255, 255))

    # 右下角的小 J：竖线 + 底部半圆钩
    jx = int(W * 0.735)
    jtop = int(W * 0.30)
    jbot = int(W * 0.66)
    jw = int(stroke * 0.8)
    d.line([(jx, jtop), (jx, jbot)], fill=(224, 242, 254, 255), width=jw)
    hook = int(W * 0.085)
    d.arc(
        [jx - 2 * hook, jbot - hook, jx, jbot + hook],
        start=0,
        end=180,
        fill=(224, 242, 254, 255),
        width=jw,
    )
    for p in ((jx, jtop), (jx - 2 * hook, jbot)):
        r = jw / 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(224, 242, 254, 255))

    icon = img.resize((SIZE, SIZE), Image.LANCZOS)
    out = os.path.join(os.path.dirname(__file__), "..", "media", "icon.png")
    icon.save(out, "PNG", optimize=True)
    print("written", os.path.abspath(out), icon.size)


if __name__ == "__main__":
    main()
