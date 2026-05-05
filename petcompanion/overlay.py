"""Frameless transparent overlay window using GTK3 + WebKit2.

On Wayland, transparency requires the X11 (XWayland) backend.
We set GDK_BACKEND=x11 before importing GTK to ensure this.

The overlay covers the full screen so the pet can be placed anywhere.
Click-through uses X11 input shape: only the pet area captures mouse
events; everything else passes through to windows below.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

# Force X11 backend for RGBA transparency support (Wayland native
# GTK3 does not support transparent top-level windows).
os.environ["GDK_BACKEND"] = "x11"

log = logging.getLogger("pet-companion")
DEFAULT_PET_WIDTH = 96
DEFAULT_PET_HEIGHT = 96
DEFAULT_PET_MARGIN = 24


def _has_deps() -> bool:
    try:
        import gi  # noqa: F401

        gi.require_version("Gtk", "3.0")
        gi.require_version("Gdk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import Gtk, WebKit2, Gdk  # noqa: F401

        return True
    except (ImportError, ValueError):
        return False


def run_overlay(url: str = "http://127.0.0.1:19821") -> None:
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import Gdk, Gtk, WebKit2

    window = Gtk.Window()
    window.set_title("Pet Companion")
    window.set_decorated(False)
    window.set_app_paintable(True)
    window.set_keep_above(True)
    window.set_skip_taskbar_hint(True)
    window.set_skip_pager_hint(True)
    window.set_type_hint(Gdk.WindowTypeHint.UTILITY)

    # Cover the full primary monitor
    display = Gdk.Display.get_default()
    monitor = None
    if display:
        monitor = display.get_primary_monitor() or display.get_monitor(0)
    if monitor:
        geom = monitor.get_geometry()
        window.set_default_size(geom.width, geom.height)
        window.move(geom.x, geom.y)

    # RGBA visual for transparency
    screen = window.get_screen()
    visual = screen.get_rgba_visual() if screen else None
    if visual:
        window.set_visual(visual)

    def _draw(widget, cr):
        cr.set_source_rgba(0, 0, 0, 0)
        cr.set_operator(2)  # CAIRO_OPERATOR_SOURCE
        cr.paint()
        return False

    window.connect("draw", _draw)
    window.connect("destroy", Gtk.main_quit)

    webview = WebKit2.WebView()
    settings = webview.get_settings()
    settings.set_enable_write_console_messages_to_stdout(True)

    bg = Gdk.RGBA()
    bg.parse("rgba(0,0,0,0)")
    webview.set_background_color(bg)
    webview.load_uri(url)

    window.add(webview)
    window.show_all()

    # --- Native drag handle window ---
    import cairo
    from gi.repository import GLib

    pad = 24
    base_x = geom.x if monitor else 0
    base_y = geom.y if monitor else 0

    _pos = {
        "x": 0,
        "y": 0,
        "w": 0,
        "h": 0,
        "dragging": False,
        "pressed": False,
        "motion_count": 0,
        "press_root_x": 0,
        "press_root_y": 0,
        "handle_x": 0,
        "handle_y": 0,
    }

    handle_window = Gtk.Window()
    handle_window.set_title("Pet Companion Drag Handle")
    handle_window.set_decorated(False)
    handle_window.set_app_paintable(True)
    handle_window.set_keep_above(True)
    handle_window.set_skip_taskbar_hint(True)
    handle_window.set_skip_pager_hint(True)
    handle_window.set_accept_focus(False)
    handle_window.set_type_hint(Gdk.WindowTypeHint.UTILITY)
    handle_window.set_default_size(
        DEFAULT_PET_WIDTH + 2 * pad, DEFAULT_PET_HEIGHT + 2 * pad
    )
    if visual:
        handle_window.set_visual(visual)
    handle_window.connect("draw", _draw)
    window.connect("destroy", lambda *_args: handle_window.destroy())
    handle_box = Gtk.EventBox()
    handle_box.set_visible_window(False)
    handle_window.add(handle_box)
    handle_window.show_all()
    handle_window.move(
        base_x + geom.width - DEFAULT_PET_WIDTH - DEFAULT_PET_MARGIN - pad
        if monitor
        else 400,
        base_y + geom.height - DEFAULT_PET_HEIGHT - DEFAULT_PET_MARGIN - pad
        if monitor
        else 400,
    )
    log.info("handle-window: ready")

    def _dispatch_drag_event(
        name: str, x: int | None = None, y: int | None = None
    ) -> None:
        if x is None or y is None:
            script = f'window.dispatchEvent(new CustomEvent("{name}"));'
        else:
            script = (
                f'window.dispatchEvent(new CustomEvent("{name}", '
                f'{{detail:{{clientX:{x},clientY:{y},button:0}}}}));'
            )
        webview.run_javascript(script, None, None)

    def _set_main_clickthrough() -> None:
        gdk_win = window.get_window()
        if not gdk_win:
            return
        gdk_win.input_shape_combine_region(cairo.Region(), 0, 0)

    def _move_handle(x: int, y: int, w: int, h: int) -> None:
        if w <= 0 or h <= 0:
            log.info("handle-window: keeping fallback rect because DOM rect is empty")
            return
        width = w + 2 * pad
        height = h + 2 * pad
        handle_x = base_x + x - pad
        handle_y = base_y + y - pad
        _pos["handle_x"] = handle_x
        _pos["handle_y"] = handle_y
        handle_window.move(handle_x, handle_y)
        handle_window.resize(width, height)
        if not handle_window.get_visible():
            handle_window.show_all()
        log.info(
            "handle-rect: x=%d y=%d w=%d h=%d",
            handle_x,
            handle_y,
            width,
            height,
        )

    _JS_GET_POS = (
        "(function(){"
        'var el=document.querySelector(".pet-overlay");'
        "if(!el)"
        "return JSON.stringify({x:0,y:0,w:0,h:0,dragging:false});"
        "var r=el.getBoundingClientRect();"
        "return JSON.stringify({"
        "x:Math.round(r.left),"
        "y:Math.round(r.top),"
        "w:Math.round(r.width),"
        "h:Math.round(r.height),"
        'dragging:el.dataset.petDragging==="true"});'
        "})()"
    )

    def _on_js_result(webview, result) -> None:
        try:
            js_result = webview.run_javascript_finish(result)
            if not js_result:
                return
            val = js_result.get_js_value()
            if not val or not val.is_string():
                return
            pos = json.loads(val.to_string())
            changed = False
            for key in ("x", "y", "w", "h"):
                v = int(pos.get(key, 0))
                if v != _pos[key]:
                    _pos[key] = v
                    changed = True
            dragging = bool(pos.get("dragging", False))
            if dragging != _pos["dragging"]:
                _pos["dragging"] = dragging
                changed = True
            if changed and not _pos["pressed"]:
                _move_handle(_pos["x"], _pos["y"], _pos["w"], _pos["h"])
                log.info(
                    "dom-rect: x=%d y=%d w=%d h=%d dragging=%s",
                    _pos["x"],
                    _pos["y"],
                    _pos["w"],
                    _pos["h"],
                    _pos["dragging"],
                )
        except Exception as exc:
            log.debug("js-poll error: %s", exc)

    def _poll(webview) -> bool:
        webview.run_javascript(_JS_GET_POS, None, _on_js_result)
        return True

    def _set_pressed(pressed: bool) -> None:
        if _pos["pressed"] == pressed:
            return
        _pos["pressed"] = pressed
        if not pressed:
            _move_handle(_pos["x"], _pos["y"], _pos["w"], _pos["h"])

    def _on_button_press(_widget, event):
        if getattr(event, "button", None) != 1:
            return False
        _pos["motion_count"] = 0
        _pos["press_root_x"] = int(event.x_root)
        _pos["press_root_y"] = int(event.y_root)
        _set_pressed(True)
        log.info(
            "handle-press: root=(%s,%s) rect=(%s,%s,%s,%s)",
            int(event.x_root),
            int(event.y_root),
            _pos["x"],
            _pos["y"],
            _pos["w"],
            _pos["h"],
        )
        _dispatch_drag_event(
            "petcompanion-drag-start",
            int(event.x_root - base_x),
            int(event.y_root - base_y),
        )
        return True

    def _on_button_release(_widget, event):
        if getattr(event, "button", None) != 1:
            return False
        log.info("handle-release: motions=%d", int(_pos["motion_count"]))
        _dispatch_drag_event("petcompanion-drag-end")
        _set_pressed(False)
        return True

    def _on_motion_notify(_widget, event):
        if not _pos["pressed"]:
            return False
        _pos["motion_count"] += 1
        dx = int(event.x_root) - int(_pos["press_root_x"])
        dy = int(event.y_root) - int(_pos["press_root_y"])
        handle_window.move(int(_pos["handle_x"]) + dx, int(_pos["handle_y"]) + dy)
        if _pos["motion_count"] <= 3 or _pos["motion_count"] % 20 == 0:
            log.info(
                "handle-motion: count=%d root=(%s,%s) delta=(%s,%s)",
                int(_pos["motion_count"]),
                int(event.x_root),
                int(event.y_root),
                dx,
                dy,
            )
        _dispatch_drag_event(
            "petcompanion-drag-move",
            int(event.x_root - base_x),
            int(event.y_root - base_y),
        )
        return True

    handle_box.add_events(
        Gdk.EventMask.BUTTON_PRESS_MASK
        | Gdk.EventMask.BUTTON_RELEASE_MASK
        | Gdk.EventMask.POINTER_MOTION_MASK
    )
    handle_box.connect("button-press-event", _on_button_press)
    handle_box.connect("button-release-event", _on_button_release)
    handle_box.connect("motion-notify-event", _on_motion_notify)

    # Wait for the page to render, then start polling
    def _start_polling() -> bool:
        _set_main_clickthrough()
        _move_handle(_pos["x"], _pos["y"], _pos["w"], _pos["h"])
        GLib.timeout_add(200, _poll, webview)
        return False

    GLib.timeout_add(500, _start_polling)

    log.info("Overlay window opened: %s", url)
    Gtk.main()


def main(args: argparse.Namespace | None = None) -> None:
    if args is None:
        parser = argparse.ArgumentParser(description="Pet overlay window")
        parser.add_argument("--url", default="http://127.0.0.1:19821")
        parser.add_argument("-v", "--verbose", action="store_true")
        args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    if not _has_deps():
        log.error(
            "Missing dependencies. Install: sudo apt install gir1.2-webkit2-4.1 python3-gi"
        )
        sys.exit(1)

    run_overlay(url=args.url)


if __name__ == "__main__":
    main()
