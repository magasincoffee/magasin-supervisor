"""MPC-004 read-only project navigation fixture; no local service is started."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "control-center"))
from project_tree_catalogue import read_only_project_catalogue  # noqa: E402


class ProjectTreeCatalogueTests(unittest.TestCase):
    def test_seed_restricts_to_three_authoritative_source_links(self):
        data = read_only_project_catalogue()
        self.assertEqual(data["schemaVersion"], "magasin-project-tree-navigation.v1")
        self.assertTrue(data["readOnly"])
        self.assertFalse(data["projectSwitchAllowed"])
        self.assertFalse(data["businessDispatchAllowed"])
        self.assertEqual([p["id"] for p in data["projects"]],
                         ["supervisor", "workforce", "print-ops"])
        self.assertTrue(all(p["scopeStatus"] == "UNKNOWN" for p in data["projects"]))
        self.assertTrue(all(p["sourceUrl"].startswith("https://github.com/magasincoffee/")
                            for p in data["projects"]))

    def test_real_task_ids_are_derived_from_local_sot_but_status_is_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.md"
            path.write_text(
                "| ID | Dependency | Deliverable | Acceptance |\n"
                "|---|---|---|---|\n"
                "| MPC-004 | 003 | Cây quản lý dự án | smoke |\n"
                "| MPC-005 | 004 | Evidence view | QA |\n"
                "| MPC-999 | 001 | fake task | fake |\n",
                encoding="utf-8"
            )
            data = read_only_project_catalogue(path)
        features = data["projects"][0]["features"]
        self.assertEqual(len(features), 1)
        tasks = features[0]["tasks"]
        self.assertEqual([t["id"] for t in tasks], ["MPC-004", "MPC-005"])
        self.assertTrue(all(t["scopeStatus"] == "UNKNOWN" for t in tasks))
        self.assertEqual(data["projects"][1]["features"], [])
        self.assertEqual(data["projects"][2]["features"], [])

    def test_absent_or_corrupt_source_does_not_invent_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.md"
            empty = read_only_project_catalogue(path)
            self.assertEqual(empty["projects"][0]["features"], [])
            path.write_bytes(b"\xff")
            invalid = read_only_project_catalogue(path)
            self.assertEqual(invalid["projects"][0]["features"], [])

    def test_duplicate_ids_fail_closed_without_synthetic_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dup.md"
            path.write_text("| MPC-004 | 003 | A | QA |\n| MPC-004 | 003 | B | QA |\n",
                            encoding="utf-8")
            result = read_only_project_catalogue(path)
        self.assertEqual(result["projects"][0]["features"], [])


if __name__ == "__main__":
    unittest.main()
