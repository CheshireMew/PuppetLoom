from pathlib import Path
import unittest


SKILL_ROOT = Path(__file__).resolve().parents[1]


class RuntimePerformanceContracts(unittest.TestCase):
    def test_wrapper_exposes_performance_command(self) -> None:
        wrapper = (SKILL_ROOT / "scripts" / "invoke_puppetloom.ps1").read_text(encoding="utf-8")
        self.assertIn('"performance"', wrapper)

    def test_full_delivery_requires_exact_revision_performance_evidence(self) -> None:
        skill = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
        workflow = (SKILL_ROOT / "references" / "from-zero-workflow.md").read_text(encoding="utf-8")
        self.assertIn("performance.valid", skill)
        self.assertIn("固定 fixture", skill)
        self.assertIn("performance --project", workflow)
        self.assertIn("--revision <n>", workflow)
        self.assertIn("活动态和暂停态", workflow)

    def test_diagnosis_separates_frame_drops_from_motion_timing(self) -> None:
        repair = (SKILL_ROOT / "references" / "agent-review-and-repair.md").read_text(encoding="utf-8")
        self.assertIn("卡顿与动作停顿的区分", repair)
        self.assertIn("暂停态稳定而只有活动态失败", repair)
        self.assertIn("两者都通过但视觉仍像停住", repair)
        self.assertIn("不能用性能全绿否定", repair)


if __name__ == "__main__":
    unittest.main()
