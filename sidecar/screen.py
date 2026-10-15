"""Screen capture with GDI and without CAPTUREBLT: regions for OCR and
small luminance frames for the app's change detection.

Lumi's windows normally exclude themselves from captures (content
protection). When the user wants them visible to OBS and Remote Desktop,
the app sends their rectangles as `exclude` and they are painted over in
flat gray here, so Lumi never sees (or reads) itself.

Electron's desktopCapturer.getSources took ~400 ms per call and blocked
the app's main thread, where the click-through mouse hook runs: the system
pointer froze at every capture. Here it costs ~30 ms, on a sidecar thread.

mss (and many other libraries) BitBlt with SRCCOPY | CAPTUREBLT. With DWM
composition the flag is useless (layered windows are already in the
composed desktop), but it makes Windows hide and redraw the mouse pointer
on every capture: the pointer stutters at every OCR tick. Plain SRCCOPY
doesn't touch the pointer.
"""

from __future__ import annotations

import ctypes
import math
import sys
from ctypes import wintypes

SRCCOPY = 0x00CC0020
HALFTONE = 4
DIB_RGB_COLORS = 0
BI_RGB = 0
# Painted over Lumi's own windows: flat, so the change detection sees no change there
EXCLUDE_GRAY = 0x808080

Rect = dict


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


def _gdi():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    user32.GetDC.restype = wintypes.HDC
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
    gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
    gdi32.SelectObject.restype = wintypes.HGDIOBJ
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi32.StretchBlt.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.DWORD]
    gdi32.SetStretchBltMode.argtypes = [wintypes.HDC, ctypes.c_int]
    gdi32.SetBrushOrgEx.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    gdi32.BitBlt.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD]
    gdi32.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.CreateSolidBrush.restype = wintypes.HBRUSH
    gdi32.CreateSolidBrush.argtypes = [wintypes.COLORREF]
    user32.FillRect.argtypes = [wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.HBRUSH]
    return user32, gdi32


def scaled_excludes(exclude: list[Rect] | None, x: int, y: int, width: int, height: int, out_w: int, out_h: int) -> list[tuple[int, int, int, int]]:
    """Screen rectangles (physical px) as (left, top, right, bottom) in the output image, clipped; empty ones dropped."""
    out = []
    sx, sy = out_w / max(1, width), out_h / max(1, height)
    for r in exclude or []:
        left = max(0, math.floor((r["x"] - x) * sx))
        top = max(0, math.floor((r["y"] - y) * sy))
        right = min(out_w, math.ceil((r["x"] + r["width"] - x) * sx))
        bottom = min(out_h, math.ceil((r["y"] + r["height"] - y) * sy))
        if right > left and bottom > top:
            out.append((left, top, right, bottom))
    return out


def grab_bgra(x: int, y: int, width: int, height: int, exclude: list[Rect] | None = None) -> bytes:
    """Top-down BGRA pixels of a screen rectangle in physical pixels (the process must be DPI aware)."""
    width, height = max(1, width), max(1, height)
    return _grab(x, y, width, height, width, height, exclude)


def thumbnail_size(width: int, height: int, max_side: int) -> tuple[int, int]:
    scale = min(1.0, max_side / max(width, height, 1))
    return max(1, round(width * scale)), max(1, round(height * scale))


def grab_luma(x: int, y: int, width: int, height: int, max_side: int = 640, exclude: list[Rect] | None = None) -> tuple[int, int, bytes]:
    """A screen rectangle shrunk to fit `max_side` (averaged, so text changes don't alias), one luminance byte per pixel."""
    import numpy as np

    out_w, out_h = thumbnail_size(width, height, max_side)
    bgra = np.frombuffer(_grab(x, y, max(1, width), max(1, height), out_w, out_h, exclude), np.uint8).reshape(out_h, out_w, 4)
    # Same weights as the app's lumaFromBgra
    luma = (bgra[..., 2].astype(np.uint16) * 77 + bgra[..., 1].astype(np.uint16) * 150 + bgra[..., 0].astype(np.uint16) * 29) >> 8
    return out_w, out_h, luma.astype(np.uint8).tobytes()


def grab_jpeg(x: int, y: int, width: int, height: int, max_side: int, quality: int = 75, exclude: list[Rect] | None = None) -> tuple[int, int, bytes]:
    """A screen rectangle shrunk to fit `max_side`, as JPEG (screenshots for the vision model)."""
    import io

    from PIL import Image

    out_w, out_h = thumbnail_size(width, height, max_side)
    image = Image.frombytes("RGB", (out_w, out_h), _grab(x, y, max(1, width), max(1, height), out_w, out_h, exclude), "raw", "BGRX")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    return out_w, out_h, buffer.getvalue()


def _grab(x: int, y: int, width: int, height: int, out_w: int, out_h: int, exclude: list[Rect] | None = None) -> bytes:
    if sys.platform != "win32":
        raise RuntimeError("screen capture is only implemented on Windows")
    user32, gdi32 = _gdi()
    screen = user32.GetDC(None)
    memdc = gdi32.CreateCompatibleDC(screen)
    bitmap = gdi32.CreateCompatibleBitmap(screen, out_w, out_h)
    old = gdi32.SelectObject(memdc, bitmap)
    try:
        if (out_w, out_h) == (width, height):
            ok = gdi32.BitBlt(memdc, 0, 0, width, height, screen, x, y, SRCCOPY)
        else:
            gdi32.SetStretchBltMode(memdc, HALFTONE)
            gdi32.SetBrushOrgEx(memdc, 0, 0, None)
            ok = gdi32.StretchBlt(memdc, 0, 0, out_w, out_h, screen, x, y, width, height, SRCCOPY)
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())
        boxes = scaled_excludes(exclude, x, y, width, height, out_w, out_h)
        if boxes:
            brush = gdi32.CreateSolidBrush(EXCLUDE_GRAY)
            try:
                for box in boxes:
                    user32.FillRect(memdc, ctypes.byref(wintypes.RECT(*box)), brush)
            finally:
                gdi32.DeleteObject(brush)
        info = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), out_w, -out_h, 1, 32, BI_RGB, 0, 0, 0, 0, 0)
        buffer = ctypes.create_string_buffer(out_w * out_h * 4)
        if gdi32.GetDIBits(memdc, bitmap, 0, out_h, buffer, ctypes.byref(info), DIB_RGB_COLORS) != out_h:
            raise RuntimeError("GetDIBits failed")
        return buffer.raw
    finally:
        gdi32.SelectObject(memdc, old)
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(memdc)
        user32.ReleaseDC(None, screen)
