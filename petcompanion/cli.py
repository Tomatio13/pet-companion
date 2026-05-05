"""Command-line interface for the Pet Companion."""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

from petcompanion import __version__
from petcompanion.assets import scan_pets
from petcompanion.config import load_config, save_config, pets_dir, ensure_dirs

DEFAULT_PORT = 19821
LOG = logging.getLogger("pet-companion")
OVERLAY_BACKENDS = ("auto", "gtk", "electron", "browser")


def _hook_read_payload() -> dict:
    try:
        raw = sys.stdin.read().strip()
    except OSError:
        return {}
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _hook_extract_tool(payload: dict) -> str | None:
    candidates = [
        payload.get("tool_name"),
        payload.get("toolName"),
        payload.get("tool"),
        payload.get("name"),
    ]
    tool_input = payload.get("tool_input")
    if isinstance(tool_input, dict):
        candidates.extend(
            [
                tool_input.get("tool_name"),
                tool_input.get("toolName"),
                tool_input.get("tool"),
                tool_input.get("name"),
            ]
        )
    for value in candidates:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _hook_extract_success(payload: dict) -> bool:
    for key in ("success", "ok"):
        value = payload.get(key)
        if isinstance(value, bool):
            return value
    for key in ("status", "result", "outcome"):
        value = payload.get(key)
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"success", "ok", "passed", "pass", "completed"}:
                return True
            if normalized in {"error", "failed", "fail"}:
                return False
    for key in ("exit_code", "exitCode", "code"):
        value = payload.get(key)
        if isinstance(value, int):
            return value == 0
    for response_key in ("tool_response", "tool_output"):
        tool_output = payload.get(response_key)
        if not isinstance(tool_output, dict):
            continue
        for key in ("success", "ok"):
            value = tool_output.get(key)
            if isinstance(value, bool):
                return value
        for key in ("status", "result", "outcome"):
            value = tool_output.get(key)
            if isinstance(value, str):
                normalized = value.strip().lower()
                if normalized in {"success", "ok", "passed", "pass", "completed"}:
                    return True
                if normalized in {"error", "failed", "fail"}:
                    return False
        for key in ("exit_code", "exitCode", "code"):
            value = tool_output.get(key)
            if isinstance(value, int):
                return value == 0
    return True


def _hook_extract_message(payload: dict) -> str | None:
    for key in ("message", "error", "stderr", "summary"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for response_key in ("tool_response", "tool_output"):
        tool_output = payload.get(response_key)
        if isinstance(tool_output, dict):
            for key in ("message", "error", "stderr", "summary"):
                value = tool_output.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return None


def _emit_event(
    event_type: str,
    *,
    port: int,
    tool: str | None = None,
    status: str | None = None,
    message: str | None = None,
) -> None:
    event: dict = {"type": event_type}
    if tool:
        event["tool"] = tool
    if status:
        event["status"] = status
    if message:
        event["message"] = message

    url = f"http://127.0.0.1:{port}/api/event"
    data = json.dumps(event).encode()
    req = Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        urlopen(req, timeout=3).read()
    except URLError:
        pass


def cmd_start(args: argparse.Namespace) -> None:
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    # --pet: validate and persist before starting server
    if args.pet:
        available = {p["id"] for p in scan_pets()}
        if args.pet not in available:
            print(f"Error: unknown pet '{args.pet}'", file=sys.stderr)
            print("Available pets:", file=sys.stderr)
            for p in scan_pets():
                print(f"  {p['id']}", file=sys.stderr)
            sys.exit(1)
        config = load_config()
        if config.get("petId") != args.pet:
            config["petId"] = args.pet
            save_config(config)
            print(f"Switched pet to '{args.pet}'")

    url = f"http://{args.host}:{args.port}"
    selected_backend = _resolve_overlay_backend(args)
    print(f"Pet Companion starting at {url}")
    print(f"Overlay backend: {selected_backend}")

    if not args.no_open:
        import threading

        def _open():
            import time

            time.sleep(1.0)
            _launch_with_backend(
                url,
                backend=selected_backend,
                verbose=args.verbose,
                explicit_backend=args.overlay_backend != "auto" or args.browser,
            )

        threading.Thread(target=_open, daemon=True).start()

    from petcompanion.server import start_server

    start_server(host=args.host, port=args.port)


def _find_overlay_script() -> tuple[str | None, str | None]:
    """Find a Python that has gi + WebKit2 and the overlay.py path.

    Returns (python_path, overlay_py_path) or (None, None).
    """
    import petcompanion.overlay as _ov

    overlay_path = str(Path(_ov.__file__).resolve())

    # Try current interpreter first
    try:
        import gi  # noqa: F401

        gi.require_version("Gtk", "3.0")
        gi.require_version("WebKit2", "4.1")
        return sys.executable, overlay_path
    except (ImportError, ValueError):
        pass

    # Try system Python
    for candidate in ("/usr/bin/python3", "/usr/bin/python"):
        if Path(candidate).exists():
            return candidate, overlay_path

    return None, overlay_path


def _overlay_log_path(name: str) -> Path:
    log_path = Path.home() / ".config" / "pet-companion" / "overlay.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    return log_path.parent / name


def _desktop_dir() -> Path:
    package_dir = Path(__file__).resolve().parent
    packaged_desktop = package_dir / "desktop"
    if (packaged_desktop / "main.js").exists():
        return packaged_desktop
    repo_desktop = package_dir.parent / "desktop"
    return repo_desktop


def _find_electron_executable() -> str | None:
    desktop_dir = _desktop_dir()
    local_candidates = [
        desktop_dir / "node_modules" / ".bin" / "electron",
        desktop_dir / "node_modules" / ".bin" / "electron.cmd",
    ]
    for candidate in local_candidates:
        if candidate.exists():
            return str(candidate)
    return shutil.which("electron")


def _launch_electron_overlay(url: str, verbose: bool = False) -> bool:
    electron = _find_electron_executable()
    if electron is None:
        LOG.warning(
            "Electron overlay is unavailable. Install desktop deps in %s",
            _desktop_dir(),
        )
        return False

    main_js = _desktop_dir() / "main.js"
    if not main_js.exists():
        LOG.error("Electron overlay entrypoint is missing: %s", main_js)
        return False

    log_path = _overlay_log_path("electron-overlay.log")
    env = os.environ.copy()
    env["PET_COMPANION_URL"] = url
    try:
        with open(log_path, "a", encoding="utf-8") as log_file:
            print(
                f"Launching Electron overlay: {url} (electron={electron})",
                file=log_file,
                flush=True,
            )
            cmd = [electron, str(main_js), "--url", url]
            if verbose:
                cmd.append("--verbose")
            subprocess.Popen(
                cmd,
                cwd=_desktop_dir(),
                env=env,
                stdout=log_file,
                stderr=log_file,
            )
        LOG.info("Electron overlay launched (electron=%s, log=%s)", electron, log_path)
        return True
    except Exception as e:
        LOG.error("Failed to launch Electron overlay: %s", e)
        return False


def _launch_gtk_overlay(url: str, verbose: bool = False) -> bool:
    """Launch the frameless GTK overlay window in a subprocess."""
    log_path = _overlay_log_path("overlay.log")

    python, overlay_path = _find_overlay_script()
    if python is None or overlay_path is None:
        LOG.warning("Cannot find Python with gi/WebKit2 for GTK overlay")
        return False

    try:
        with open(log_path, "a", encoding="utf-8") as log_file:
            print(
                f"Launching overlay: {url} (python={python})", file=log_file, flush=True
            )
            cmd = [python, overlay_path, "--url", url]
            if verbose:
                cmd.append("--verbose")
            subprocess.Popen(cmd, stdout=log_file, stderr=log_file)
        LOG.info("Overlay launched (python=%s, log=%s)", python, log_path)
        return True
    except Exception as e:
        LOG.error("Failed to launch overlay: %s", e)
        return False


def _resolve_overlay_backend(args: argparse.Namespace) -> str:
    if getattr(args, "browser", False):
        return "browser"
    backend = getattr(args, "overlay_backend", "auto")
    if backend != "auto":
        return backend
    if _find_electron_executable() is not None:
        return "electron"
    if sys.platform.startswith("linux") and _find_overlay_script()[0] is not None:
        return "gtk"
    return "browser"


def _launch_with_backend(
    url: str,
    *,
    backend: str,
    verbose: bool = False,
    explicit_backend: bool = False,
) -> None:
    if backend == "browser":
        webbrowser.open(url)
        return
    if backend == "gtk":
        if _launch_gtk_overlay(url, verbose=verbose):
            return
        if explicit_backend:
            LOG.error("GTK overlay launch failed; not falling back because backend was explicitly requested")
            return
        LOG.warning("GTK overlay launch failed; falling back to browser")
        webbrowser.open(url)
        return
    if backend == "electron":
        if _launch_electron_overlay(url, verbose=verbose):
            return
        if explicit_backend:
            LOG.error("Electron overlay launch failed; not falling back because backend was explicitly requested")
            return
        LOG.warning("Electron overlay launch failed; falling back to browser")
        webbrowser.open(url)
        return
    if backend == "auto":
        _launch_with_backend(
            url,
            backend=_resolve_overlay_backend(
                argparse.Namespace(browser=False, overlay_backend="auto")
            ),
            verbose=verbose,
            explicit_backend=False,
        )
        return
    raise ValueError(f"Unknown overlay backend: {backend}")


def cmd_overlay(args: argparse.Namespace) -> None:
    backend = _resolve_overlay_backend(args)
    if backend == "gtk":
        from petcompanion.overlay import main as overlay_main

        overlay_main(args)
        return
    if backend == "electron":
        ok = _launch_electron_overlay(args.url, verbose=args.verbose)
        if not ok:
            sys.exit(1)
        return
    webbrowser.open(args.url)


def cmd_emit(args: argparse.Namespace) -> None:
    event: dict = {"type": args.event_type}
    if args.tool:
        event["tool"] = args.tool
    if args.status:
        event["status"] = args.status
    if args.message:
        event["message"] = args.message

    url = f"http://127.0.0.1:{args.port}/api/event"
    data = json.dumps(event).encode()
    req = Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        resp = urlopen(req, timeout=3)
        result = json.loads(resp.read())
        delivered = result.get("delivered", 0)
        if delivered:
            print(f"Event '{args.event_type}' delivered to {delivered} client(s)")
        else:
            print(f"Event '{args.event_type}' accepted (no connected clients)")
    except URLError:
        print(
            f"Error: Pet Companion is not running on port {args.port}", file=sys.stderr
        )
        print("Start it with: pet-companion start", file=sys.stderr)
        sys.exit(1)


def cmd_hook_emit(args: argparse.Namespace) -> None:
    payload = _hook_read_payload()
    event_name = args.hook_event

    if event_name == "user-prompt-submit":
        _emit_event(
            "thinking",
            port=args.port,
            message="Thinking...",
        )
        return

    tool = _hook_extract_tool(payload)

    if event_name == "pre-tool-use":
        message = f"Running {tool}..." if tool else "Running a tool..."
        _emit_event(
            "tool-use",
            port=args.port,
            tool=tool,
            message=message,
        )
        return

    if event_name == "post-tool-use":
        success = _hook_extract_success(payload)
        status = "success" if success else "error"
        message = _hook_extract_message(payload)
        if not message:
            if tool:
                message = (
                    f"{tool} finished successfully."
                    if success
                    else f"{tool} failed."
                )
            else:
                message = "Done." if success else "Something went wrong."
        _emit_event(
            "tool-result",
            port=args.port,
            tool=tool,
            status=status,
            message=message,
        )
        return

    if event_name == "stop":
        _emit_event(
            "idle",
            port=args.port,
            message="Idle.",
        )
        return


def cmd_list(args: argparse.Namespace) -> None:
    from petcompanion.assets import scan_pets

    pets = scan_pets()
    if not pets:
        print("No pets found.")
        return
    for pet in pets:
        tag = " [bundled]" if pet.get("bundled") else " [custom]"
        print(f"  {pet['id']:20s} {pet['displayName']}{tag}")
    print(f"\n  {len(pets)} pet(s) total")


def cmd_install_hooks(args: argparse.Namespace) -> None:
    templates = Path(__file__).parent.parent / "hooks"
    agent = args.agent

    template_map = {
        "claude-code": ("claude-code.json", "~/.claude/settings.json"),
        "codex-cli": ("codex-cli.json", "~/.codex/hooks.json"),
        "quiet-droid": ("quiet-droid.json", ".quiet-droid/hooks.json"),
    }

    if agent not in template_map:
        print(
            f"Unknown agent: {agent}. Choose from: {', '.join(template_map)}",
            file=sys.stderr,
        )
        sys.exit(1)

    tmpl_name, dest_hint = template_map[agent]
    tmpl_path = templates / tmpl_name
    if not tmpl_path.exists():
        print(f"Template not found: {tmpl_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Hook template for {agent}:")
    print(f"  Template: {tmpl_path}")
    print(f"  Install to: {dest_hint}")
    print()
    print("Contents:")
    print(tmpl_path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="pet-companion",
        description="Pet Companion - A standalone animated pet for AI coding agents",
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {__version__}"
    )
    sub = parser.add_subparsers(dest="command")

    # start
    p_start = sub.add_parser("start", help="Start the pet companion server")
    p_start.add_argument("--host", "-H", default="127.0.0.1")
    p_start.add_argument("--port", "-p", type=int, default=DEFAULT_PORT)
    p_start.add_argument(
        "--browser",
        action="store_true",
        help="Open in a normal browser instead of the default desktop overlay",
    )
    p_start.add_argument(
        "--overlay-backend",
        choices=OVERLAY_BACKENDS,
        default="auto",
        help="Overlay backend: auto, gtk, electron, or browser",
    )
    p_start.add_argument(
        "--no-open", action="store_true", help="Don't open browser/overlay"
    )
    p_start.add_argument("--pet", "-P", help="Pet to launch (e.g. tux, clippit, dario)")
    p_start.add_argument("--verbose", "-v", action="store_true")
    p_start.set_defaults(func=cmd_start)

    # overlay
    p_overlay = sub.add_parser("overlay", help="Open the desktop overlay window")
    p_overlay.add_argument("--url", default=f"http://127.0.0.1:{DEFAULT_PORT}")
    p_overlay.add_argument(
        "--overlay-backend",
        choices=OVERLAY_BACKENDS,
        default="auto",
        help="Overlay backend: auto, gtk, electron, or browser",
    )
    p_overlay.add_argument("--verbose", "-v", action="store_true")
    p_overlay.set_defaults(func=cmd_overlay)

    # emit
    p_emit = sub.add_parser("emit", help="Send an event to the pet companion")
    p_emit.add_argument(
        "event_type",
        help="Event type: idle, thinking, tool-use, tool-result, failed, review, message",
    )
    p_emit.add_argument("--tool", "-t", help="Tool name (for tool-use/tool-result)")
    p_emit.add_argument(
        "--status", "-s", help="Status: success or error (for tool-result)"
    )
    p_emit.add_argument("--message", "-m", help="Custom message for speech bubble")
    p_emit.add_argument("--port", "-p", type=int, default=DEFAULT_PORT)
    p_emit.set_defaults(func=cmd_emit)

    p_hook_emit = sub.add_parser(
        "hook-emit", help="Read hook JSON from stdin and emit a pet event"
    )
    p_hook_emit.add_argument(
        "hook_event",
        choices=["user-prompt-submit", "pre-tool-use", "post-tool-use", "stop"],
    )
    p_hook_emit.add_argument("--port", "-p", type=int, default=DEFAULT_PORT)
    p_hook_emit.set_defaults(func=cmd_hook_emit)

    # list
    p_list = sub.add_parser("list", help="List available pets")
    p_list.set_defaults(func=cmd_list)

    # install-hooks
    p_hooks = sub.add_parser("install-hooks", help="Show hook config for an agent")
    p_hooks.add_argument("agent", choices=["claude-code", "codex-cli", "quiet-droid"])
    p_hooks.set_defaults(func=cmd_install_hooks)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    args.func(args)
