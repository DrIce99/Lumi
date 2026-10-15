"""Draws Lumi's launcher icon: two capsule eyes on a dark background.

Writes the PNGs Android needs (legacy icon, and the adaptive icon's
foreground layer) for every density under android/app/src/main/res.
The background color lives in values/ic_launcher_background.xml.
Run from phone/: python tools/make_icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

RES = Path(__file__).resolve().parent.parent / "android" / "app" / "src" / "main" / "res"
BG = (14, 14, 20, 255)
EYE = (245, 243, 238, 255)
GLOW = (245, 243, 238, 90)
SUPER = 4  # supersampling for smooth edges

# Launcher sizes (dp 48) and adaptive foreground sizes (dp 108) per density
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def capsule(draw: ImageDraw.ImageDraw, cx: float, cy: float, w: float, h: float, fill) -> None:
    draw.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], radius=w / 2, fill=fill)


def eyes(size: int, background: bool) -> Image.Image:
    """Both eyes at `size` px. `background`: the rounded dark tile (legacy icon)."""
    s = size * SUPER
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if background:
        draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=BG)
    # Eyes: 0.14 wide, 0.46 tall, centers 0.39 and 0.61 of the width
    w, h = s * 0.14, s * 0.46
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    for fx in (0.39, 0.61):
        capsule(gdraw, s * fx, s * 0.5, w * 1.5, h * 1.08, GLOW)
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.035))
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)
    for fx in (0.39, 0.61):
        capsule(draw, s * fx, s * 0.5, w, h, EYE)
    return img.resize((size, size), Image.LANCZOS)


def write(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "PNG")


def main() -> None:
    for name, scale in DENSITIES.items():
        launcher = round(48 * scale)
        foreground = round(108 * scale)
        write(RES / f"mipmap-{name}" / "ic_launcher.png", eyes(launcher, background=True))
        write(RES / f"mipmap-{name}" / "ic_launcher_round.png", eyes(launcher, background=True))
        write(RES / f"mipmap-{name}" / "ic_launcher_foreground.png", eyes(foreground, background=False))
    print("icons written to", RES)


if __name__ == "__main__":
    main()
