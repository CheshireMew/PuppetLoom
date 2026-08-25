import { useEffect, useState } from "react";
import type { EnvironmentDoctorReport, ProjectLibraryReport, SourcePreparationTask, SourceReviewResult } from "@puppetloom/core";
import { CheckCircle2, ClipboardCheck, Download, ExternalLink, FileImage, FolderKanban, FolderOpen, FolderOutput, RefreshCw, ScanSearch, Settings2, TriangleAlert, X } from "lucide-react";

type ProductionSection = "library" | "source" | "system";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function scoreTone(score: number): string {
  return score >= 90 ? "ready" : score >= 70 ? "review" : "blocked";
}

export function ProductionCenter({ initialSection, onClose, onEdit }: { initialSection: ProductionSection; onClose: () => void; onEdit: (directory: string) => void }): React.JSX.Element {
  const [section, setSection] = useState<ProductionSection>(initialSection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [libraryRoot, setLibraryRoot] = useState("");
  const [library, setLibrary] = useState<ProjectLibraryReport>();
  const [reference, setReference] = useState("");
  const [taskDirectory, setTaskDirectory] = useState("");
  const [taskName, setTaskName] = useState("");
  const [task, setTask] = useState<SourcePreparationTask>();
  const [candidate, setCandidate] = useState("");
  const [review, setReview] = useState<SourceReviewResult>();
  const [decision, setDecision] = useState<"ready" | "needs-repair">("ready");
  const [decisionNote, setDecisionNote] = useState("");
  const [comparisonUrl, setComparisonUrl] = useState("");
  const [environment, setEnvironment] = useState<EnvironmentDoctorReport>();
  const [update, setUpdate] = useState<Awaited<ReturnType<typeof window.puppetloom.updateCheck>>>();

  useEffect(() => () => { if (comparisonUrl) URL.revokeObjectURL(comparisonUrl); }, [comparisonUrl]);

  async function chooseDirectory(setter: (value: string) => void): Promise<void> {
    const directory = await window.puppetloom.chooseProject();
    if (directory) setter(directory);
  }

  async function scanLibrary(): Promise<void> {
    if (!libraryRoot) return;
    setBusy(true); setError("");
    try { setLibrary(await window.puppetloom.scanProjectLibrary(libraryRoot, 4, 200)); }
    catch (cause) { setError(`项目库扫描失败：${messageOf(cause)}`); }
    finally { setBusy(false); }
  }

  async function createTask(): Promise<void> {
    if (!reference || !taskDirectory) return;
    setBusy(true); setError(""); setReview(undefined);
    try {
      const result = await window.puppetloom.prepareSourceTask({ reference, output: taskDirectory, ...(taskName.trim() ? { name: taskName.trim() } : {}) });
      setTask(result.task);
      setTaskDirectory(result.directory);
    } catch (cause) { setError(`素材任务创建失败：${messageOf(cause)}`); }
    finally { setBusy(false); }
  }

  async function inspectCandidate(): Promise<void> {
    if (!taskDirectory || !candidate) return;
    setBusy(true); setError(""); setReview(undefined); setDecisionNote("");
    if (comparisonUrl) { URL.revokeObjectURL(comparisonUrl); setComparisonUrl(""); }
    try {
      const result = await window.puppetloom.reviewSourceCandidate(taskDirectory, candidate);
      setReview(result); setTask(result.task);
      const current = result.task.reviews.at(-1);
      if (current) {
        const blob = await window.puppetloom.readProjectFile(taskDirectory, `${current.directory}/reference-comparison.png`);
        setComparisonUrl(URL.createObjectURL(blob));
      }
    } catch (cause) { setError(`候选 PSD 复核失败：${messageOf(cause)}`); }
    finally { setBusy(false); }
  }

  async function finalize(): Promise<void> {
    const current = review?.task.reviews.at(-1);
    if (!current || !decisionNote.trim()) return;
    setBusy(true); setError("");
    try {
      const updated = await window.puppetloom.finalizeSourceReview(taskDirectory, current.index, decision, decisionNote);
      setTask(updated);
      setReview((value) => value ? { ...value, task: updated } : value);
    } catch (cause) { setError(`素材结论保存失败：${messageOf(cause)}`); }
    finally { setBusy(false); }
  }

  async function inspectSystem(): Promise<void> {
    setBusy(true); setError("");
    try { const [doctor, updateStatus] = await Promise.all([window.puppetloom.environmentDoctor(), window.puppetloom.updateCheck()]); setEnvironment(doctor); setUpdate(updateStatus); }
    catch (cause) { setError(`环境检查失败：${messageOf(cause)}`); }
    finally { setBusy(false); }
  }

  return <section className="production-center" data-testid="production-center">
    <header className="production-center-header"><div><span>生产中心</span><h1>{section === "library" ? "角色项目库与体检" : section === "source" ? "原画与分层素材准备" : "Windows 环境与更新"}</h1><p>{section === "library" ? "统一检查项目文件、revision、证据、素材能力和录制状态。" : section === "source" ? "保存每版候选与视觉证据，再把确认后的 PSD 交给创建器。" : "检查本机运行条件，并在明确操作后下载或安装新版本。"}</p></div><button className="icon-only" aria-label="关闭生产中心" onClick={onClose}><X /></button></header>
    <nav className="production-tabs"><button className={section === "library" ? "active" : ""} onClick={() => setSection("library")}><FolderKanban />项目库</button><button className={section === "source" ? "active" : ""} onClick={() => setSection("source")}><FileImage />素材准备</button><button className={section === "system" ? "active" : ""} onClick={() => { setSection("system"); if (!environment) void inspectSystem(); }}><Settings2 />环境与更新</button></nav>
    {section === "library" ? <div className="production-library">
      <section className="production-controls"><label><span>项目库根目录</span><small>{libraryRoot || "选择只包含角色项目的本机目录"}</small></label><button className="with-icon" disabled={busy} onClick={() => void chooseDirectory(setLibraryRoot)}><FolderOpen />选择目录</button><button className="primary with-icon" disabled={busy || !libraryRoot} onClick={() => void scanLibrary()}><ScanSearch />{busy ? "正在体检…" : "扫描全部项目"}</button></section>
      {!library && <div className="production-empty"><FolderKanban /><strong>等待扫描项目库</strong><span>扫描有明确深度和项目数量上限，不会修改任何角色。</span></div>}
      {library && <><section className="library-summary"><div><span>项目</span><strong>{library.summary.total}</strong></div><div><span>有效</span><strong>{library.summary.valid}</strong></div><div><span>需要处理</span><strong>{library.summary.needsAttention}</strong></div><div><span>待验收证据</span><strong>{library.summary.pendingEvidence}</strong></div><div><span>平均分</span><strong>{library.summary.averageScore}</strong></div></section><div className="production-project-list">{library.projects.map((project) => <article key={project.projectDirectory}><div className={`project-score ${scoreTone(project.score)}`}>{project.score}</div><div className="project-health-copy"><strong>{project.project}</strong><span>revision {project.revision} · {project.capabilities.rigLevel} · {project.capabilities.layers} 层</span><small>{project.issues.filter((issue) => issue.severity !== "info").map((issue) => issue.message).join("；") || "文件、证据和生产素材均已就绪"}</small></div><div className="project-health-actions"><button className="with-icon" onClick={() => onEdit(project.projectDirectory)}><ExternalLink />打开</button><button className="with-icon" onClick={() => void window.puppetloom.revealPath(project.projectDirectory)}><FolderOpen />目录</button></div></article>)}</div></>}
    </div> : section === "source" ? <div className="production-source">
      <section className="source-task-column"><h2>1. 建立素材任务</h2><label><span>原始角色图</span><small>{reference || "PNG、JPG 或 WebP"}</small></label><button className="with-icon" disabled={busy} onClick={async () => { const value = await window.puppetloom.chooseReference(); if (value) setReference(value); }}><FileImage />选择原画</button><label><span>任务目录</span><small>{taskDirectory || "选择一个新目录或空目录"}</small></label><button className="with-icon" disabled={busy} onClick={async () => { const value = await window.puppetloom.chooseOutput(); if (value) setTaskDirectory(value); }}><FolderOutput />选择目录</button><label><span>角色名称</span><input value={taskName} maxLength={80} placeholder="可选" onChange={(event) => setTaskName(event.target.value)} /></label><button className="primary with-icon" disabled={busy || !reference || !taskDirectory} onClick={() => void createTask()}><ClipboardCheck />创建分层任务</button>{task && <div className={`source-task-status ${task.status}`}><strong>{task.name}</strong><span>{task.status}</span><small>{task.reviews.length} 版候选</small></div>}</section>
      <section className="source-review-column"><h2>2. 复核候选 PSD</h2><label><span>已有任务目录</span><small>{taskDirectory || "可以直接打开已有素材任务"}</small></label><button className="with-icon" disabled={busy} onClick={() => void chooseDirectory(setTaskDirectory)}><FolderOpen />打开任务</button><label><span>候选 PSD</span><small>{candidate || "每次复核都会复制为新的候选版本"}</small></label><button className="with-icon" disabled={busy} onClick={async () => { const value = await window.puppetloom.choosePsd(); if (value) setCandidate(value); }}><FileImage />选择 PSD</button><button className="primary with-icon" disabled={busy || !taskDirectory || !candidate} onClick={() => void inspectCandidate()}><ScanSearch />{busy ? "正在生成证据…" : "保存候选并复核"}</button>{review && <div className={`review-result ${review.blockers.length ? "blocked" : "ready"}`}>{review.blockers.length ? <TriangleAlert /> : <CheckCircle2 />}<strong>{review.blockers.length ? `${review.blockers.length} 个结构阻断项` : "自动结构检查通过"}</strong>{review.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}<button className="with-icon" onClick={() => void window.puppetloom.revealPath(review.reviewDirectory)}><FolderOpen />查看全部证据</button></div>}</section>
      <section className="source-evidence-column"><h2>3. 目视确认</h2>{comparisonUrl ? <img src={comparisonUrl} alt="原画与 PSD 重组并排对比" /> : <div className="production-empty compact"><FileImage /><strong>等待候选证据</strong><span>这里会显示原画与 PSD 重组并排对比。</span></div>}{review && <><div className="decision-choice"><button className={decision === "ready" ? "active" : ""} disabled={review.blockers.length > 0} onClick={() => setDecision("ready")}><CheckCircle2 />可以创建</button><button className={decision === "needs-repair" ? "active" : ""} onClick={() => setDecision("needs-repair")}><TriangleAlert />需要修复</button></div><label><span>目视结论</span><textarea value={decisionNote} placeholder="说明轮廓、五官、遮挡托底、边缘和画布位置的检查结果" onChange={(event) => setDecisionNote(event.target.value)} /></label><button className="primary with-icon" disabled={busy || !decisionNote.trim()} onClick={() => void finalize()}><ClipboardCheck />保存本版结论</button></>}</section>
    </div> : <div className="production-system">
      <section className="production-controls"><div><strong>本机环境检查</strong><small>只检查当前 Windows 和项目需要的本机依赖。</small></div><button className="primary with-icon" disabled={busy} onClick={() => void inspectSystem()}><RefreshCw />{busy ? "正在检查…" : "重新检查"}</button></section>
      {environment && <div className="environment-checks">{environment.checks.map((check) => <article className={check.status} key={check.id}>{check.status === "passed" ? <CheckCircle2 /> : <TriangleAlert />}<div><strong>{check.label}</strong><span>{check.message}</span>{check.value && <small>{check.value}</small>}</div></article>)}</div>}
      {update && <section className="update-card"><div><strong>应用更新</strong><span>{update.message}</span><small>当前版本 {update.currentVersion}{update.manifest ? ` · 可用版本 ${update.manifest.version}` : ""}</small></div>{update.available && !update.installer && <button className="primary with-icon" disabled={busy} onClick={async () => { setBusy(true); try { setUpdate(await window.puppetloom.updateDownload()); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); } }}><Download />下载更新</button>}{update.installer && <button className="primary with-icon" onClick={() => void window.puppetloom.updateInstall(update.installer!)}><Download />退出并安装</button>}</section>}
    </div>}
    {error && <div className="error production-error" role="alert">{error}</div>}
  </section>;
}
