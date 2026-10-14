"""Synthetic only: no H4, no SQLite access, no GitHub network calls."""
import importlib.util
import pathlib
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / ".github" / "scripts" / "magasin-dispatch-reporter.py"
spec = importlib.util.spec_from_file_location("local_receipt_reporter", SOURCE)
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)


class LocalMCPReceiptEnvTests(unittest.TestCase):
    def test_valid_bounded_decimal_issue(self):
        for raw, expected in [("", 0), ("381", 381), ("1", 1), ("999999999", 999999999)]:
            with self.subTest(raw=raw):
                self.assertEqual(reporter.validated_issue_number_from_environment(raw), expected)

    def test_invalid_issue_text_rejected_without_shell_or_network(self):
        for raw in ("0", "000381", "-1", "1234567890", "123 & whoami",
                    "381|echo", "381\n999", "%COMSPEC%", None, 381, "../secrets"):
            with self.subTest(raw=repr(raw)):
                with self.assertRaises(ValueError):
                    reporter.validated_issue_number_from_environment(raw)


if __name__ == "__main__":
    unittest.main()
