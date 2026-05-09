import argparse
import io
import json
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from petcompanion import cli


class _FakeResponse:
    def __init__(self, payload: dict):
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")


class CliSayTests(unittest.TestCase):
    @patch("petcompanion.cli.urlopen")
    def test_cmd_say_posts_message_event(self, mock_urlopen):
        mock_urlopen.return_value = _FakeResponse({"delivered": 1})
        args = argparse.Namespace(message="波動拳！", port=19821)

        stdout = io.StringIO()
        with redirect_stdout(stdout):
            cli.cmd_say(args)

        self.assertEqual(stdout.getvalue().strip(), "Message delivered to 1 client(s)")
        request = mock_urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(
            payload,
            {
                "type": "message",
                "message": "波動拳！",
            },
        )

    @patch("petcompanion.cli.urlopen")
    def test_cmd_emit_reuses_post_event(self, mock_urlopen):
        mock_urlopen.return_value = _FakeResponse({"delivered": 0})
        args = argparse.Namespace(
            event_type="tool-result",
            tool="build",
            status="error",
            message="Build failed",
            port=19821,
        )

        stdout = io.StringIO()
        with redirect_stdout(stdout):
            cli.cmd_emit(args)

        self.assertEqual(
            stdout.getvalue().strip(),
            "Event 'tool-result' accepted (no connected clients)",
        )
        request = mock_urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(
            payload,
            {
                "type": "tool-result",
                "tool": "build",
                "status": "error",
                "message": "Build failed",
            },
        )


if __name__ == "__main__":
    unittest.main()
