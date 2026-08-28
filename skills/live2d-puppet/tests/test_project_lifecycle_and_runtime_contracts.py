from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ProjectLifecycleAndRuntimeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        cls.workflow = (ROOT / "references" / "from-zero-workflow.md").read_text(encoding="utf-8")
        cls.source_art = (ROOT / "references" / "source-art-and-layering.md").read_text(encoding="utf-8")
        cls.visual = (ROOT / "references" / "visual-rigging-rules.md").read_text(encoding="utf-8")
        cls.review = (ROOT / "references" / "agent-review-and-repair.md").read_text(encoding="utf-8")

    def test_all_task_artifacts_stay_under_the_canonical_root(self) -> None:
        self.assertIn("测试、生成、中间、最终产物", self.skill)
        self.assertIn("全部写在该根目录内", self.workflow)
        self.assertIn("依赖、缓存和桌面应用用户数据", self.skill)
        self.assertIn("-OutputRoot E:\\Puppets\\work\\layering-review", self.source_art)
        self.assertNotIn("Skill 自有且被忽略的 `runtime/see-through", self.source_art)
        self.assertNotIn("E:\\Repairs", self.workflow)
        self.assertNotIn("E:\\Output", self.source_art)
        self.assertIn("“最近项目”记录的是同一个绝对路径", self.skill)
        self.assertIn("CLI 创建成功但桌面端没有读取规范项目", self.workflow)

    def test_psd_migration_uses_internal_staging_and_one_canonical_path(self) -> None:
        self.assertIn("work\\psd-refresh-v2\\candidate", self.workflow)
        self.assertIn("移动到项目内部带时间或 revision 的 `archive` 目录", self.workflow)
        self.assertIn("把候选晋升到原规范项目路径", self.workflow)
        self.assertNotIn("--output E:\\Puppets\\Character-v2", self.workflow)
        self.assertNotIn("用 `migrate` 创建新项目", self.skill)

    def test_whole_layer_order_means_global_occlusion_closure(self) -> None:
        self.assertIn("每一组可见重叠和遮挡关系", self.workflow)
        self.assertIn("所有可见重叠关系的全局闭环", self.source_art)
        self.assertIn("更新 PSD 后即使只有少数纹理变化", self.workflow)
        self.assertIn("外衣与脖子", self.workflow)
        self.assertIn("项链主体与吊坠", self.source_art)

    def test_default_expression_assets_are_closed_open_and_baked_eye_safe(self) -> None:
        combined = self.skill + self.workflow + self.source_art + self.visual + self.review
        self.assertNotIn("缺少左右闭眼、微张嘴或张口", combined)
        self.assertNotIn("缺闭眼、微张嘴或张口", combined)
        self.assertIn("默认只补真正缺少的一个张口和闭眼状态", self.visual)
        self.assertIn("烘焙眼必须使用带正确肤色", self.visual)
        self.assertIn("确认原眼完全消失", self.workflow)
        self.assertIn("微张嘴或音素嘴形只有用户明确需要", self.review)

    def test_microphone_diagnosis_fixes_state_selection_before_timing(self) -> None:
        self.assertIn("实时麦克风默认只在闭口和一个张口之间选择", self.visual)
        self.assertIn("先检查实际参与选择的嘴层数量", self.visual)
        self.assertIn("状态图正确后才调整滞回、平滑、响应和释放", self.visual)
        self.assertIn("停止说话后及时回到闭口", self.visual)
        self.assertIn("不能用延长保持时间掩盖竞争状态", self.visual)

    def test_fixed_attachment_and_free_end_have_separate_influence(self) -> None:
        self.assertIn("连接主体固定随父级、真正自由端才叠加次级运动", self.skill)
        self.assertIn("固定端的相对运动应接近零", self.visual)
        self.assertIn("释放量从连接处向自由端连续增加", self.visual)
        self.assertIn("不能让整件头饰或整条项链同幅摆动", self.visual)
        self.assertIn("局部释放向耳尖递增", self.visual)


if __name__ == "__main__":
    unittest.main()
