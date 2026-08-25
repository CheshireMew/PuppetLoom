from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "scripts" / "invoke_puppetloom.ps1"


class PsdRepairSkillContractTests(unittest.TestCase):
    def test_wrapper_exposes_the_real_psd_repair_lifecycle(self) -> None:
        expectations = {
            ("psd", "--help"): ("repair", "review", "finalize"),
            ("psd", "repair", "--help"): ("--recipe", "--output", "--workdir", "--dry-run", "--json"),
            ("psd", "review", "--help"): ("--input", "--recipe", "--workdir", "--json"),
            ("psd", "finalize", "--help"): ("--workdir", "--decision", "--json"),
        }
        for arguments, flags in expectations.items():
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(WRAPPER), *arguments],
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

    def test_docs_separate_detection_import_cleanup_and_psd_repair(self) -> None:
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        workflow = (ROOT / "references" / "from-zero-workflow.md").read_text(encoding="utf-8")
        layering = (ROOT / "references" / "source-art-and-layering.md").read_text(encoding="utf-8")
        combined = skill + workflow + layering
        for phrase in (
            "背景残片",
            "硬矩形托底",
            "检测到矩形边界本身不等于可以删",
            "隐藏的运动延展",
            "delete-layer",
            "clear-region",
            "duplicate-layer",
            "remove-white-matte",
            "defringe",
            "psd repair",
            "psd review",
            "psd finalize",
            "awaiting-visual-review",
            "原 PSD 永不覆盖",
            "同一个 workdir 重跑",
            "不能被表述为 PSD 已经修好",
            "逐部件来源清单",
            "规范画布",
            "fit-full-canvas",
            "不能把 RGB 亮度、灰度或“越白越透明”直接映射为 Alpha",
            "layer-detail-sheet.png",
            "layer-alpha-sheet.png",
            "PSD 能重新打开",
            "Photoshop 已经运行时不得连接或复用用户会话",
        ):
            self.assertIn(phrase, combined)

    def test_photoshop_runner_uses_explicit_full_canvas_scaling_and_boundary_selection(self) -> None:
        runner = (ROOT.parents[1] / "scripts" / "photoshop-psd-repair.jsx").read_text(encoding="utf-8")
        for phrase in (
            "fit-full-canvas",
            "resizeImage",
            "selectBackgroundMagicWand",
            "source.selection.invert()",
            "removeWhiteMatte",
        ):
            self.assertIn(phrase, runner)
        self.assertNotIn("selectWhiteRange", runner)

    def test_photoshop_runner_refuses_an_active_user_session(self) -> None:
        wrapper = (ROOT.parents[1] / "scripts" / "run-photoshop-psd-repair.ps1").read_text(encoding="utf-8")
        process_guard = wrapper.index("Get-Process -Name Photoshop")
        com_connection = wrapper.index("New-Object -ComObject Photoshop.Application")
        self.assertLess(process_guard, com_connection)
        for phrase in (
            "Photoshop is already running; refusing to attach",
            "remainingDocuments",
            "$application.Visible = $true",
        ):
            self.assertIn(phrase, wrapper)


if __name__ == "__main__":
    unittest.main()
