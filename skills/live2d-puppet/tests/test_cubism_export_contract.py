import unittest
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CubismExportContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        cls.cubism = (ROOT / "references/cubism-bridge-workflow.md").read_text(encoding="utf-8")

    def test_cubism_bridge_preserves_the_official_boundary(self) -> None:
        combined = self.skill + self.cubism
        for phrase in (
            ".moc3", ".model3.json", "External API 1.1.0", "strictReady",
            "--allow-partial", "EditEnd { Cancel: true }", "ParamEyeLOpen",
            "cubism finalize", "cubism verify", "Cubism Viewer",
        ):
            self.assertIn(phrase, combined)
        self.assertIn("cubism export", combined)
        self.assertIn("awaiting-visual-review", combined)
        self.assertIn("实际导出图集", combined)
        self.assertIn("ArtMesh 顶点坐标或 Warp 控制点坐标", self.cubism)


    def test_wrapper_matches_the_real_cubism_cli(self) -> None:
        expectations = {
            ("cubism", "--help"): ("export", "plan", "prepare", "finalize", "verify", "open", "editor"),
            ("cubism", "export", "--help"): ("--project", "--output", "--editor-version", "--runtime-version"),
            ("cubism", "plan", "--help"): ("--project", "--json"),
            ("cubism", "finalize", "--help"): ("--project", "--editor-model", "--output"),
            ("cubism", "verify", "--help"): ("--model", "--json"),
            ("cubism", "editor", "--help"): ("inspect", "sync", "preview", "clear-preview"),
            ("cubism", "editor", "sync", "--help"): ("--project", "--allow-partial", "--token-file"),
        }
        wrapper = ROOT / "scripts" / "invoke_puppetloom.ps1"
        for arguments, flags in expectations.items():
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(wrapper), *arguments],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            for flag in flags:
                self.assertIn(flag, result.stdout)
