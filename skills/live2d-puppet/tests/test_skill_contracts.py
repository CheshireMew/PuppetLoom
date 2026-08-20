from __future__ import annotations

import sys
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from file_budget import MAX_OUTER_TOOL_TOKENS, collect_file_budgets, validate_file_budgets


class SkillContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        cls.workflow = (ROOT / "references" / "from-zero-workflow.md").read_text(encoding="utf-8")
        cls.review = (ROOT / "references" / "agent-review-and-repair.md").read_text(encoding="utf-8")
        cls.visual = (ROOT / "references" / "visual-rigging-rules.md").read_text(encoding="utf-8")
        cls.learning = (ROOT / "references" / "calibration-and-learning.md").read_text(encoding="utf-8")
        cls.cubism = (ROOT / "references" / "cubism-bridge-workflow.md").read_text(encoding="utf-8")
        cls.wrapper = (ROOT / "scripts" / "invoke_puppetloom.ps1").read_text(encoding="utf-8")

    def test_routes_every_active_reference_and_script(self) -> None:
        for relative in (
            "references/from-zero-workflow.md",
            "references/agent-review-and-repair.md",
            "references/visual-rigging-rules.md",
            "references/calibration-and-learning.md",
            "references/cubism-bridge-workflow.md",
            "scripts/invoke_puppetloom.ps1",
            "scripts/file_budget.py",
        ):
            self.assertIn(relative, self.skill)

    def test_public_cli_loop_is_complete(self) -> None:
        combined = self.skill + self.workflow
        for command in ("inspect", "create", "verify", "describe", "migrate", "render", "agent", "author", "calibrate", "compare", "history", "restore", "evidence", "enhance", "record", "edit", "play", "cubism"):
            self.assertIn(command, combined)
            self.assertIn(f'"{command}"', self.wrapper)

    def test_wrapper_matches_the_real_editing_and_evidence_cli(self) -> None:
        expectations = {
            "describe": ("--layer", "--revision"),
            "migrate": ("--input", "--output"),
            "enhance": ("--assets",),
            "render": ("--output", "--suite", "--revision", "--size", "--focus"),
            "evidence": ("--project", "--session", "--status"),
            "record": ("--mode", "--duration", "--fps", "--revision"),
            "play": ("--revision",),
        }
        wrapper = ROOT / "scripts" / "invoke_puppetloom.ps1"
        for command, flags in expectations.items():
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(wrapper), command, "--help"],
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

    def test_wrapper_matches_the_real_agent_first_cli(self) -> None:
        expectations = {
            ("agent", "--help"): ("specification", "plan", "apply", "front-hair", "secondary"),
            ("agent", "specification", "--help"): ("--project", "--scope", "--json"),
            ("agent", "plan", "--help"): ("--project", "--spec", "--instruction", "--scope", "--json"),
            ("agent", "apply", "--help"): ("--project", "--spec", "--instruction", "--scope", "--json"),
            ("agent", "front-hair", "plan", "--help"): ("--project", "--instruction", "--layer"),
            ("agent", "front-hair", "apply", "--help"): ("--project", "--instruction", "--layer"),
            ("agent", "secondary", "plan", "--help"): ("--project", "--part", "--instruction", "--layer"),
            ("agent", "secondary", "apply", "--help"): ("--project", "--part", "--instruction", "--layer"),
            ("author", "--help"): ("inspect", "apply"),
            ("author", "inspect", "--help"): ("--project", "--json"),
            ("author", "apply", "--help"): ("--project", "--patch", "--json"),
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

    def test_agent_first_route_is_scoped_and_visually_verified(self) -> None:
        combined = self.skill + self.workflow + self.review + self.learning
        for phrase in (
            "agent plan",
            "agent apply",
            "agent specification",
            "--spec",
            "structured-specification",
            "--scope whole",
            "agent front-hair plan",
            "agent front-hair apply",
            "author inspect/apply",
            "not-present",
            "needs-assets",
            "verification",
            "focusComparisonSheet",
            "focusMotionSheet",
            "focusMotionManifest",
            "逐点编辑只是备用能力",
            "未点名区域",
            "准确 revision",
        ):
            self.assertIn(phrase, combined)

    def test_external_agent_owns_orchestration(self) -> None:
        combined = self.skill + self.workflow + self.review
        self.assertIn("外部 Agent", combined)
        self.assertIn("桌面应用不运行 Agent 编排", combined)
        self.assertIn("桌面应用只用于播放、查看和必要的人工兜底", combined)
        self.assertIn("软件不得用几条关键词正则冒充自然语言理解", combined)
        self.assertIn("外部 Agent 必须承担的视觉判断", combined)

    def test_wrapper_matches_the_real_cubism_cli(self) -> None:
        expectations = {
            ("cubism", "--help"): ("plan", "prepare", "finalize", "verify", "open", "editor"),
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

    def test_dynamic_revision_topology_and_migration_are_hard_requirements(self) -> None:
        combined = self.skill + self.workflow + self.visual + self.learning
        for phrase in ("alphaTopology", "baseProjectSha256", "headAndBodyFrozen", "currentRevisionAtStart", "geometry-changed", "解剖学左右"):
            self.assertIn(phrase, combined)
        rejected = self.workflow.index("标为 `rejected`")
        restored = self.workflow.index("restore --revision", rejected)
        stopped = self.workflow.index("停止", restored)
        self.assertLess(rejected, restored)
        self.assertLess(restored, stopped)

    def test_visual_rules_preserve_exposed_project_lessons(self) -> None:
        for phrase in ("近大远小", "上下看是俯视/仰视", "脖子不是滞后的头发", "前发根部随头骨", "耳朵以头侧根部为铰链", "尾巴以身体连接处为锚点", "脚不能随呼吸位移", "十五种嘴形", "同一 ArtMesh", "源图像像素"):
            self.assertIn(phrase, self.skill + self.visual)

    def test_learning_requires_generic_causal_evidence_not_a_project_count_ritual(self) -> None:
        self.assertIn("一个角色的接受记录本身不足以修改通用自动绑定算法", self.learning)
        self.assertIn("至少两个项目", self.learning)
        self.assertIn("不是绝对前置条件", self.learning)
        self.assertIn("通用 fixture", self.learning)
        self.assertIn("角色专用顶点列表", self.learning)
        self.assertIn("用户明确要求", self.learning)
        self.assertIn("$meta-skills", self.learning)

    def test_mature_projects_are_audited_without_redundant_revisions(self) -> None:
        combined = self.skill + self.workflow
        for phrase in (
            "先审查，后写入",
            "若没有待修缺陷",
            "不创建新 revision",
            "整模 `apply` 不是整体事务",
            "后续部位 `blocked`",
            "当前只有前发 Agent",
            "不能替代对全部历史 accepted 结果的视觉保护清单",
        ):
            self.assertIn(phrase, combined)

    def test_user_constraints_and_candidate_acceptance_are_binding(self) -> None:
        combined = self.skill + self.workflow + self.review + self.visual + self.learning
        for phrase in (
            "只使用现有素材",
            "不得运行 `enhance`",
            "不要视频",
            "不运行 `record`",
            "evidence --project <directory> --session <id> --status accepted",
            "用户看候选前",
            "最后接受的 revision",
        ):
            self.assertIn(phrase, combined)

    def test_repeated_visual_failure_routes_to_root_cause_evidence(self) -> None:
        combined = self.review + self.visual
        for phrase in (
            "源 Alpha",
            "neutral 状态 ArtMesh",
            "目标姿态下的网格/轮廓边界",
            "最终实际像素",
            "亚像素差异",
            "共享网格不等于共享语义",
        ):
            self.assertIn(phrase, combined)

    def test_cubism_bridge_preserves_the_official_boundary(self) -> None:
        combined = self.skill + self.cubism
        for phrase in (
            ".moc3", ".model3.json", "External API 1.1.0", "strictReady",
            "--allow-partial", "EditEnd { Cancel: true }", "ParamEyeLOpen",
            "cubism finalize", "cubism verify", "Cubism Viewer",
        ):
            self.assertIn(phrase, combined)
        self.assertIn("必须由 Cubism Editor", combined)
        self.assertIn("ArtMesh 顶点坐标或 Warp 控制点坐标", self.cubism)

    def test_local_file_budget_covers_all_active_text(self) -> None:
        self.assertEqual(validate_file_budgets(ROOT), [])
        records = collect_file_budgets(ROOT)
        self.assertGreaterEqual(len(records), 8)
        self.assertTrue(all(item.estimated_tokens <= MAX_OUTER_TOOL_TOKENS for item in records))


if __name__ == "__main__":
    unittest.main()
