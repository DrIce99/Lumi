"""UI Automation: the element with the keyboard focus, its rectangle, the
caret (where the user is typing), the current line and the selection.

Chrome, VS Code and other Electron apps don't move the system caret, but
they expose it through UIA TextPattern2. Everything is polled on one
thread with COM initialized; consumers get only the changes. Password
fields never report any text.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from .caret import caret_info

log = logging.getLogger("lumi.uia")

POLL_SECONDS = 0.12
MAX_NAME = 120


def rect_json(rect) -> dict | None:
    if rect is None:
        return None
    width, height = rect.right - rect.left, rect.bottom - rect.top
    if width <= 0 or height <= 0:
        return None
    return {"x": rect.left, "y": rect.top, "width": width, "height": height}


def snapshot(auto) -> dict | None:
    """The focused element, caret and text around it (physical screen pixels)."""
    control = auto.GetFocusedControl()
    if control is None:
        return None
    try:
        is_password = bool(control.IsPassword)
    except Exception:
        is_password = False
    focus = {
        "name": "" if is_password else (control.Name or "")[:MAX_NAME],
        "controlType": control.ControlTypeName,
        "className": control.ClassName,
        "processId": control.ProcessId,
        "rect": rect_json(control.BoundingRectangle),
        "isPassword": is_password,
    }
    caret, line, selection = caret_info(auto, control, with_text=not is_password)
    return {"focus": focus, "caret": caret, "line": line, "selection": selection}


class UiaMonitor:
    """Polls UI Automation on its own thread and notifies listeners of changes."""

    def __init__(self, poll_seconds: float = POLL_SECONDS):
        self.poll_seconds = poll_seconds
        self.listeners: set[Callable[[dict], None]] = set()
        self.last: dict | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.error: str | None = None

    def subscribe(self, listener: Callable[[dict], None]) -> None:
        self.listeners.add(listener)
        self.start()
        if self.last:
            listener(self.last)

    def unsubscribe(self, listener: Callable[[dict], None]) -> None:
        self.listeners.discard(listener)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="lumi-uia", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        try:
            import uiautomation as auto
        except ImportError as err:
            self.error = f"UI Automation non disponibile: {err}"
            log.warning(self.error)
            return
        # Slow apps must not make every call wait seconds
        auto.SetGlobalSearchTimeout(1)
        with auto.UIAutomationInitializerInThread():
            while not self._stop.is_set():
                if self.listeners:
                    try:
                        state = snapshot(auto)
                    except Exception as err:  # the focused app went away mid-call
                        log.debug("UIA snapshot failed: %s", err)
                        state = None
                    if state is not None and state != self.last:
                        self.last = state
                        for listener in list(self.listeners):
                            try:
                                listener(state)
                            except Exception:
                                log.exception("UIA listener failed")
                time.sleep(self.poll_seconds)
