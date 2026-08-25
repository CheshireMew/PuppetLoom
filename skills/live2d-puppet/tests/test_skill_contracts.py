from __future__ import annotations

import json
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image
from psd_tools import PSDImage

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from file_budget import IGNORED, MAX_OUTER_TOOL_TOKENS, collect_file_budgets, validate_file_budgets
from acquire_layered_psd import _export_local_psd_previews, _prepare_source, _preview_contact_sheet, _sha256
from finalize_psd_review import ReviewFinalizationError, finalize_review


REVIEW_CHECK_IDS = (
    "face-and-eyes",
    "hair-and-headwear",
    "clothing-and-limbs",
    "layer-order-and-occlusion",
    "background-and-alpha",
    "overall-recomposition",
)


def completed_checks(*, repair: str | None = None, fail: str | None = None) -> list[dict[str, str]]:
    return [
        {
            "id": check_id,
            "status": "repair" if check_id == repair else "fail" if check_id == fail else "pass",
        }
        for check_id in REVIEW_CHECK_IDS
    ]


class SkillContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        cls.workflow = (ROOT / "references" / "from-zero-workflow.md").read_text(encoding="utf-8")
        cls.source_art = (ROOT / "references" / "source-art-and-layering.md").read_text(encoding="utf-8")
        cls.local_see_through = (ROOT / "references" / "see-through-local-deployment.md").read_text(encoding="utf-8")
        cls.review = (ROOT / "references" / "agent-review-and-repair.md").read_text(encoding="utf-8")
        cls.visual = (ROOT / "references" / "visual-rigging-rules.md").read_text(encoding="utf-8")
        cls.learning = (ROOT / "references" / "calibration-and-learning.md").read_text(encoding="utf-8")
        cls.cubism = (ROOT / "references" / "cubism-bridge-workflow.md").read_text(encoding="utf-8")
        cls.demonstration = (ROOT / "references" / "runtime-demonstration.md").read_text(encoding="utf-8")
        cls.wrapper = (ROOT / "scripts" / "invoke_puppetloom.ps1").read_text(encoding="utf-8")
        cls.demo_wrapper = (ROOT / "scripts" / "demo_puppetloom.ps1").read_text(encoding="utf-8")
        cls.demo_script = (ROOT / "scripts" / "demo_puppetloom.mjs").read_text(encoding="utf-8")

    def test_routes_every_active_reference_and_script(self) -> None:
        for relative in (
            "references/from-zero-workflow.md",
            "references/source-art-and-layering.md",
            "references/see-through-local-deployment.md",
            "references/agent-review-and-repair.md",
            "references/visual-rigging-rules.md",
            "references/runtime-demonstration.md",
            "references/calibration-and-learning.md",
            "references/cubism-bridge-workflow.md",
            "scripts/invoke_puppetloom.ps1",
            "scripts/acquire_layered_psd.ps1",
            "scripts/acquire_layered_psd.py",
            "scripts/finalize_psd_review.py",
            "requirements-layering.txt",
            "scripts/demo_puppetloom.ps1",
            "scripts/demo_puppetloom.mjs",
            "scripts/file_budget.py",
        ):
            self.assertIn(relative, self.skill)

    def test_public_cli_loop_is_complete(self) -> None:
        combined = self.skill + self.workflow
        for command in ("inspect", "create", "verify", "describe", "migrate", "render", "psd", "agent", "author", "actions", "extensions", "calibrate", "compare", "history", "restore", "evidence", "enhance", "record", "edit", "play", "runtime", "cubism"):
            self.assertIn(command, combined)
            self.assertIn(f'"{command}"', self.wrapper)

    def test_source_art_and_see_through_route_is_complete(self) -> None:
        combined = self.skill + self.workflow + self.source_art + self.local_see_through
        for phrase in (
            "完全没有原图",
            "可绑定角色原图",
            "https://modelscope.cn/studios/ljsabc/See-Through/?st=1WIdxVcPQ8ylM43-0Vr14FQ",
            "https://ljsabc-see-through.ms.show",
            "/inference",
            "acquire_layered_psd.ps1",
            "分辨率选择 1024",
            "用户选择“Agent 代传”",
            "选择 Agent 代传就构成本次具体上传授权",
            "在用户选择前停止，不上传、不安装",
            "本地部署只作为",
            "E:\\Code\\see-through-webui",
            "Alpha 总和先被裁剪到 0～255",
            "group offload",
            "每批 4～6 层",
            "不限定头身比",
            "不等于简化角色设计",
            "默认不把完整鲸鱼娘原画",
            "后加入的材料默认是补充",
            "所有已经被否定的生成图",
            "逐字返回实际提示词",
            "回到仍然有效的原始参考完全重新生成",
            "压力测试",
            "第二个完整角色",
            "一条当前任务指令",
            "绿幕抠图",
            "重新合成",
            "create --reference",
            "只使用现有素材",
            "用户只要求生成或测试 PSD",
            "日系二次元单人",
            "source-original.*",
            "source-normalized.png",
            "previews/contact-sheet.png",
            "Alpha 为零区域里的无效 RGB",
            "增强诊断只用于定位像素",
            "同时给出未增强画面",
            "外接矩形面积判断污染严重程度",
            "原图没有 Alpha 只能证明原图不存在隐藏透明蒙版",
            "不能被表述为 PSD 已经修好",
            "recomposition.png",
            "comparison.png",
            "visual-review.json",
            "accepted-with-repairs",
            "blockingIssues",
            "repairPlan",
            "layer-order-and-occlusion",
            "move-layer",
        ):
            self.assertIn(phrase, combined)
        self.assertNotIn("只有原图时优先通过正式 API 自动取得 PSD", combined)
        self.assertNotIn("不为角色设计增加一次无必要的确认暂停", combined)
        self.assertNotIn("完整鲸鱼娘原画进入新原画生图上下文", combined)
        reference_directory = ROOT / "assets" / "blue-whale-maid-reference"
        for filename in (
            "blue-whale-maid-source-art.png",
            "blue-whale-maid-layered.psd",
            "head-turn-deformation-guide.png",
            "closed-eye-expression-reference.png",
            "open-mouth-expression-reference.png",
            "closed-mouth-expression-reference.png",
        ):
            self.assertTrue((reference_directory / filename).is_file(), filename)

    def test_missing_expression_art_is_agent_owned_and_style_matched(self) -> None:
        combined = self.skill + self.workflow + self.source_art + self.review + self.visual
        for phrase in (
            "不再向用户逐项索取授权",
            "已有闭嘴",
            "不能重画",
            "原画、PSD 重组图",
            "睫毛体量",
            "不能是一条弧线",
            "用户明确限定现有素材或禁止生图",
        ):
            self.assertIn(phrase, combined)
        self.assertNotIn("图像模型补表情只在用户允许新增素材时生成候选", combined)

    def test_readmes_credit_see_through_and_state_the_quality_boundary(self) -> None:
        repository = ROOT.parents[1]
        documents = "\n".join(
            (repository / name).read_text(encoding="utf-8")
            for name in ("README.md", "README.en.md", "README.ja.md", "THIRD_PARTY_NOTICES.md")
        )
        for phrase in (
            "https://github.com/shitagaki-lab/see-through",
            "https://arxiv.org/abs/2602.03749",
            "重要的一环",
            "专业角色画师和 Live2D 建模师",
            "important bridge",
            "professional character artist and Live2D modeler",
            "重要な基盤",
            "専門のキャラクターイラストレーターと Live2D モデラー",
        ):
            self.assertIn(phrase, documents)

    def test_rejected_layers_and_missing_expression_assets_do_not_enter_blind_repair(self) -> None:
        combined = self.workflow + self.source_art + self.review + self.visual
        for phrase in (
            "不进入绑定",
            "孤立部件生图",
            "具体部位、姿态或连续帧",
            "已有闭嘴图层直接作为 `mouthOpen=0`",
            "眉毛是独立表情结构",
            "通用最小幅度",
            "矩形托底",
            "恢复最后接受的 revision",
        ):
            self.assertIn(phrase, combined)
        self.assertNotIn("不透明结果只能在纯色背景上抠图再验证", combined)

    def test_see_through_client_preserves_self_contained_visual_evidence(self) -> None:
        client = (SCRIPTS / "acquire_layered_psd.py").read_text(encoding="utf-8")
        wrapper = (SCRIPTS / "acquire_layered_psd.ps1").read_text(encoding="utf-8")
        requirements = (ROOT / "requirements-layering.txt").read_text(encoding="utf-8")
        compile(client, "acquire_layered_psd.py", "exec")
        for phrase in (
            "/gradio_api/info",
            "/gradio_api/upload",
            "/gradio_api/call/inference",
            "request.json",
            "submission.json",
            "response.json",
            "inspect.json",
            "result.json",
            '"readyForCreate": False',
            'b"8BPS"',
            'destination.open("xb")',
            "source-original",
            "source-upload.png",
            "source-normalized.png",
            '"previews" / "index.json"',
            '"contact-sheet.png"',
            "recomposition.png",
            "difference.png",
            "comparison.png",
            "comparison-metrics.json",
            "visual-review.json",
            "ignore_preview=True",
            "MAX_INFERENCE_ATTEMPTS = 2",
            "--review-psd",
            "--finalize-review",
            '"blockingIssues": []',
            '"repairPlan": []',
        ):
            self.assertIn(phrase, client)
        self.assertNotIn("import requests", client)
        self.assertNotIn("gradio_client", client)
        for phrase in ("D:\\Tools\\Python310\\python.exe", "SplitLimbs", "ReviewPsd", "FinalizeReview", "-Check"):
            self.assertIn(phrase, wrapper)
        self.assertIn("[int]$Resolution = 1024", wrapper)
        self.assertIn('parser.add_argument("--resolution", type=int, default=1024)', client)
        self.assertIn("Pillow==12.2.0", requirements)
        self.assertIn("psd-tools==1.17.4", requirements)

    def test_source_preparation_preserves_original_and_creates_an_explicit_opaque_upload(self) -> None:
        runtime_root = ROOT / "runtime"
        runtime_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime_root) as temporary_directory:
            temporary = Path(temporary_directory)
            source_path = temporary / "transparent-source.png"
            source = Image.new("RGBA", (5, 3), (20, 40, 80, 0))
            source.putpixel((2, 1), (10, 30, 220, 255))
            source.save(source_path)
            original_hash = _sha256(source_path)

            run_directory = temporary / "run"
            run_directory.mkdir()
            record = _prepare_source(source_path, run_directory, (8, 8))

            self.assertEqual(_sha256(Path(record["sourceOriginal"])), original_hash)
            self.assertFalse(record["opaque"])
            self.assertTrue(record["uploadOpaque"])
            self.assertEqual(Path(record["sourceUpload"]).name, "source-upload.png")
            self.assertEqual(record["uploadSha256"], _sha256(Path(record["sourceUpload"])))
            self.assertEqual(record["normalizedSha256"], _sha256(Path(record["sourceNormalized"])))
            with Image.open(record["sourceUpload"]) as uploaded:
                self.assertEqual(uploaded.mode, "RGB")
                self.assertEqual(uploaded.size, (5, 3))
                self.assertEqual(uploaded.getpixel((0, 0)), (255, 255, 255))
                self.assertEqual(uploaded.getpixel((2, 1)), (10, 30, 220))

    def test_local_psd_review_exports_full_canvas_layer_previews_and_contact_sheet(self) -> None:
        runtime_root = ROOT / "runtime"
        runtime_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime_root) as temporary_directory:
            run_directory = Path(temporary_directory)
            psd_path = ROOT.parents[1] / "test" / "fixtures" / "semantic.psd"
            expected_canvas = PSDImage.open(psd_path).size

            preview_records = _export_local_psd_previews(psd_path, run_directory)
            contact_sheet = _preview_contact_sheet(preview_records, run_directory)

            self.assertGreater(len(preview_records), 0)
            self.assertIsNotNone(contact_sheet)
            self.assertTrue(Path(contact_sheet).is_file())
            index = json.loads((run_directory / "previews" / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(len(index["items"]), len(preview_records))
            for record in preview_records:
                self.assertTrue(record["sourcePath"])
                with Image.open(record["path"]) as preview:
                    self.assertEqual(preview.size, expected_canvas)

    def test_finalize_review_synchronizes_the_three_level_decision(self) -> None:
        runtime_root = ROOT / "runtime"
        runtime_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime_root) as temporary_directory:
            run_directory = Path(temporary_directory)
            source_original = run_directory / "source-original.png"
            psd_path = run_directory / "layered.psd"
            source_original.write_bytes(b"source")
            psd_path.write_bytes(b"8BPS-test")
            required_views = {}
            for key, filename in (
                ("sourceNormalized", "source-normalized.png"),
                ("recomposition", "recomposition.png"),
                ("comparison", "comparison.png"),
                ("previewIndex", "index.json"),
            ):
                path = run_directory / filename
                path.write_bytes(b"evidence")
                required_views[key] = str(path)
            required_views["previewContactSheet"] = None

            review_path = run_directory / "visual-review.json"
            review = {
                "status": "accepted-with-repairs",
                "acceptedForNextStage": None,
                "reviewedAt": None,
                "reviewer": "Codex external Agent",
                "blockingIssues": [],
                "repairPlan": [{"part": "ahoge", "repair": "restore the missing strand"}],
                "requiredViews": required_views,
                "checks": completed_checks(repair="hair-and-headwear"),
                "notes": ["The missing strand is repairable."],
            }
            review_path.write_text(json.dumps(review), encoding="utf-8")
            result_path = run_directory / "result.json"
            result = {
                "ok": True,
                "stage": "psd-review-evidence-generated",
                "readyForCreate": False,
                "psd": str(psd_path),
                "psdSha256": _sha256(psd_path),
                "source": {"sourceOriginal": str(source_original), "sha256": _sha256(source_original)},
                "reviewEvidence": {"visualReview": str(review_path)},
            }
            result_path.write_text(json.dumps(result), encoding="utf-8")

            summary = finalize_review(review_path)
            finalized_review = json.loads(review_path.read_text(encoding="utf-8"))
            finalized_result = json.loads(result_path.read_text(encoding="utf-8"))

            self.assertEqual(summary["status"], "accepted-with-repairs")
            self.assertTrue(summary["readyForCreate"])
            self.assertTrue(finalized_review["acceptedForNextStage"])
            self.assertEqual(finalized_result["visualReviewStatus"], "accepted-with-repairs")
            self.assertEqual(finalized_result["repairPlan"], review["repairPlan"])
            self.assertTrue(finalized_result["readyForCreate"])

    def test_finalize_review_rejects_an_internally_inconsistent_decision(self) -> None:
        runtime_root = ROOT / "runtime"
        runtime_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime_root) as temporary_directory:
            run_directory = Path(temporary_directory)
            source_original = run_directory / "source-original.png"
            psd_path = run_directory / "layered.psd"
            source_original.write_bytes(b"source")
            psd_path.write_bytes(b"8BPS-test")
            required_views = {}
            for key, filename in (
                ("sourceNormalized", "source-normalized.png"),
                ("recomposition", "recomposition.png"),
                ("comparison", "comparison.png"),
                ("previewIndex", "index.json"),
            ):
                path = run_directory / filename
                path.write_bytes(b"evidence")
                required_views[key] = str(path)
            required_views["previewContactSheet"] = None
            review_path = run_directory / "visual-review.json"
            review_path.write_text(
                json.dumps(
                    {
                        "status": "accepted-with-repairs",
                        "blockingIssues": [],
                        "repairPlan": [],
                        "requiredViews": required_views,
                        "checks": completed_checks(),
                    }
                ),
                encoding="utf-8",
            )
            result_path = run_directory / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "psd": str(psd_path),
                        "psdSha256": _sha256(psd_path),
                        "source": {"sourceOriginal": str(source_original), "sha256": _sha256(source_original)},
                        "reviewEvidence": {"visualReview": str(review_path)},
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ReviewFinalizationError, "requires a non-empty repairPlan"):
                finalize_review(review_path)

    def test_finalize_review_requires_layer_order_visual_check(self) -> None:
        review = {"checks": completed_checks()[:-1], "status": "accepted"}
        from finalize_psd_review import _validate_checks
        with self.assertRaisesRegex(ReviewFinalizationError, "missing required checks"):
            _validate_checks(review, "accepted")
        with self.assertRaisesRegex(ReviewFinalizationError, "requires accepted-with-repairs"):
            _validate_checks({"checks": completed_checks(repair="layer-order-and-occlusion")}, "accepted")

    def test_psd_only_scope_stops_before_project_or_rigging(self) -> None:
        combined = self.skill + self.workflow + self.source_art
        for phrase in (
            "PSD-only",
            "不得创建 PuppetLoom 项目",
            "不要生成 `rig-spec`",
            "不要调用 `create`、`agent plan` 或 `agent apply`",
            "完成 PSD-only 范围后立即停止",
        ):
            self.assertIn(phrase, combined)

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

    def test_wrapper_matches_actions_and_existing_project_extensions(self) -> None:
        expectations = {
            ("actions", "--help"): ("plan", "apply"),
            ("actions", "plan", "--help"): ("--project", "--json"),
            ("actions", "apply", "--help"): ("--project", "--json"),
            ("extensions", "--help"): ("plan", "apply"),
            ("extensions", "plan", "--help"): ("--project", "--torso-volume", "--json"),
            ("extensions", "apply", "--help"): ("--project", "--torso-volume", "--json"),
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

    def test_wrapper_matches_runtime_control_cli(self) -> None:
        expectations = {
            ("runtime", "--help"): ("inspect", "set", "trigger", "release", "record-start", "record-stop", "replay", "replay-stop"),
            ("runtime", "set", "--help"): ("--viewer", "--source", "--head-yaw", "--expression", "--ttl"),
            ("runtime", "trigger", "--help"): ("--viewer", "--source", "--behavior", "--expression", "--duration"),
            ("runtime", "release", "--help"): ("--viewer", "--source"),
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

    def test_cli_demo_is_editor_first_read_only_and_process_backed(self) -> None:
        combined = self.skill + self.demonstration
        for phrase in (
            "先编辑器、后角色窗口",
            "不能从会话记忆",
            "runtime inspect",
            "runtime set/trigger/release",
            "不增加 revision",
            "等待 Electron 的关闭事件",
            "不能使用没有活动进程句柄的悬空顶层 Promise",
        ):
            self.assertIn(phrase, combined)
        for value in ("--project", "--revision", "--pace", "--keep-open", "history", "runtime", "editor-ready", "viewer-ready", 'demo: "ready"'):
            self.assertIn(value, self.demo_script)
        for value in ("PUPPETLOOM_E2E_USER_DATA", "PUPPETLOOM_CONTROL_MANIFEST", "viewer.revision !== undefined", 'waitForEvent("close", { timeout: 0 })'):
            self.assertIn(value, self.demo_script)
        for forbidden in ("save()", "calibrate", "actions apply", "extensions apply"):
            self.assertNotIn(forbidden, self.demo_script)
        for value in ("PaceMs", "KeepOpen", "demo_puppetloom.mjs"):
            self.assertIn(value, self.demo_wrapper)

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
        combined = self.skill + self.visual + self.review
        for phrase in ("近大远小", "上下看是俯视/仰视", "脖子不是滞后的头发", "前发根部随头骨", "眼白、虹膜、睫毛和眉毛在转头时保持不透明", "耳朵没有统一动作模板", "耳朵参数不能驱动头饰", "旧角色的动作关系只能帮助观察", "当前项目为真源", "不能默认继承部件关系、运动方向或物理响应", "`plan` 全绿只说明规格在当前结构假设下满足已有检查", "若左右耳与头饰已经是独立层", "只有确实没有独立耳层", "支撑轮廓、整体响应和局部柔性分别检查", "尾巴以身体连接处为锚点", "脚不能随呼吸位移", "十五种嘴形", "同一 ArtMesh", "源图像像素"):
            self.assertIn(phrase, combined)
        self.assertNotIn("触发后应快速连续抬落数次", self.visual)

    def test_supported_garments_separate_structure_response_and_flexibility(self) -> None:
        combined = self.review + self.visual
        for phrase in (
            "garmentStructure",
            "garmentFlexibility",
            "塌陷",
            "太慢",
            "太硬",
            "不能靠锁死整件裙子维持体积",
        ):
            self.assertIn(phrase, combined)

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
            "重建需求清单",
            "规范项目当前 revision 的真实数据",
            "测试副本",
            "extensions plan",
            "软件升级、CLI 新增能力或项目格式增加字段不等于源 PSD 变化",
        ):
            self.assertIn(phrase, combined)

    def test_completion_claim_requires_the_real_user_path_and_canonical_project(self) -> None:
        combined = self.skill + self.workflow
        for phrase in (
            "普通默认路径或用户指定入口",
            "规范项目的准确 revision 已保存对应数据",
            "完成链中任何一环没有成立",
            "不能宣称整项完成",
            "公开入口的实际默认值或本次调用参数",
            "不能从代码存在、帮助文本、测试夹具或隔离副本反推",
        ):
            self.assertIn(phrase, combined)

    def test_alpha_import_defaults_remove_only_confirmed_noise(self) -> None:
        for phrase in (
            "`preflight`",
            "普通创建保持自动 Alpha 清理",
            "高置信度噪点",
            "疑似有效细节继续保留",
            "源 PSD 始终不改",
            "--preserve-alpha-noise",
            "--clean-alpha",
            "普通用户创建角色前必须勾选或决定",
        ):
            self.assertIn(phrase, self.workflow)

    def test_extensions_preserve_neutral_and_strands_prove_independent_motion(self) -> None:
        for phrase in (
            "脸部纵深曲线和可选的躯干体积曲线都是相对形变",
            "ArtMesh 必须严格回到加入曲线前的中立网格",
            "相邻 revision 的中立姿态",
            "不能只靠 `hairStrands` 字段数量或静态左右极限证明",
            "各发束根部应稳定附着头骨",
            "锁步同相同幅",
            "不能用逐帧随机抖动",
        ):
            self.assertIn(phrase, self.visual)

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
        self.assertIn("runtime", IGNORED)
        records = collect_file_budgets(ROOT)
        self.assertGreaterEqual(len(records), 8)
        self.assertTrue(all(item.estimated_tokens <= MAX_OUTER_TOOL_TOKENS for item in records))


if __name__ == "__main__":
    unittest.main()
