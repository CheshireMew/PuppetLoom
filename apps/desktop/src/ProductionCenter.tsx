import { useEffect, useState } from "react";
import type { EnvironmentDoctorReport, ProjectLibraryReport, SourcePreparationTask, SourceReviewResult } from "@puppetloom/core";
import { CheckCircle2, ClipboardCheck, Download, ExternalLink, FileImage, FolderKanban, FolderOpen, FolderOutput, RefreshCw, ScanSearch, Settings2, TriangleAlert, X } from "lucide-react";
import { LanguageSwitcher } from "./i18n/index.js";
import { useLocale } from "./i18n/index.js";

type ProductionSection = "library" | "source" | "system";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function scoreTone(score: number): string {
  return score >= 90 ? "ready" : score >= 70 ? "review" : "blocked";
}

export function ProductionCenter({ initialSection, onClose, onEdit }: { initialSection: ProductionSection; onClose: () => void; onEdit: (directory: string) => void }): React.JSX.Element {
  const { t } = useLocale();
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
    catch (cause) { setError(t("libraryFailed", { error: messageOf(cause) })); }
    finally { setBusy(false); }
  }

  async function createTask(): Promise<void> {
    if (!reference || !taskDirectory) return;
    setBusy(true); setError(""); setReview(undefined);
    try {
      const result = await window.puppetloom.prepareSourceTask({ reference, output: taskDirectory, ...(taskName.trim() ? { name: taskName.trim() } : {}) });
      setTask(result.task);
      setTaskDirectory(result.directory);
    } catch (cause) { setError(t("sourceTaskFailed", { error: messageOf(cause) })); }
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
    } catch (cause) { setError(t("candidateReviewFailed", { error: messageOf(cause) })); }
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
    } catch (cause) { setError(t("sourceConclusionFailed", { error: messageOf(cause) })); }
    finally { setBusy(false); }
  }

  async function inspectSystem(): Promise<void> {
    setBusy(true); setError("");
    try { const [doctor, updateStatus] = await Promise.all([window.puppetloom.environmentDoctor(), window.puppetloom.updateCheck()]); setEnvironment(doctor); setUpdate(updateStatus); }
    catch (cause) { setError(t("environmentFailed", { error: messageOf(cause) })); }
    finally { setBusy(false); }
  }

  return <section className="production-center" data-testid="production-center">
    <header className="production-center-header"><div><span>{t("productionCenter")}</span><h1>{section === "library" ? t("productionLibraryTitle") : section === "source" ? t("productionSourceTitle") : t("productionSystemTitle")}</h1><p>{section === "library" ? t("productionLibraryLead") : section === "source" ? t("productionSourceLead") : t("productionSystemLead")}</p></div><button className="icon-only" aria-label={t("closeProduction")} onClick={onClose}><X /></button></header>
    <nav className="production-tabs"><button className={section === "library" ? "active" : ""} onClick={() => setSection("library")}><FolderKanban />{t("projectLibrary")}</button><button className={section === "source" ? "active" : ""} onClick={() => setSection("source")}><FileImage />{t("sourcePrep")}</button><button className={section === "system" ? "active" : ""} onClick={() => { setSection("system"); if (!environment) void inspectSystem(); }}><Settings2 />{t("environmentUpdates")}</button></nav>
    {section === "library" ? <div className="production-library">
      <section className="production-controls"><label><span>{t("libraryRoot")}</span><small>{libraryRoot || t("libraryRootEmpty")}</small></label><button className="with-icon" disabled={busy} onClick={() => void chooseDirectory(setLibraryRoot)}><FolderOpen />{t("chooseFolder")}</button><button className="primary with-icon" disabled={busy || !libraryRoot} onClick={() => void scanLibrary()}><ScanSearch />{busy ? t("scanning") : t("scanAllProjects")}</button></section>
      {!library && <div className="production-empty"><FolderKanban /><strong>{t("waitingLibraryTitle")}</strong><span>{t("waitingLibraryBody")}</span></div>}
      {library && <><section className="library-summary"><div><span>{t("projects")}</span><strong>{library.summary.total}</strong></div><div><span>{t("valid")}</span><strong>{library.summary.valid}</strong></div><div><span>{t("needsAttention")}</span><strong>{library.summary.needsAttention}</strong></div><div><span>{t("pendingEvidence")}</span><strong>{library.summary.pendingEvidence}</strong></div><div><span>{t("averageScore")}</span><strong>{library.summary.averageScore}</strong></div></section><div className="production-project-list">{library.projects.map((project) => <article key={project.projectDirectory}><div className={`project-score ${scoreTone(project.score)}`}>{project.score}</div><div className="project-health-copy"><strong>{project.project}</strong><span>{t("projectMeta", { revision: project.revision, rig: project.capabilities.rigLevel, layers: project.capabilities.layers })}</span><small>{project.issues.filter((issue) => issue.severity !== "info").map((issue) => issue.message).join(" · ") || t("projectReady")}</small></div><div className="project-health-actions"><button className="with-icon" onClick={() => onEdit(project.projectDirectory)}><ExternalLink />{t("open")}</button><button className="with-icon" onClick={() => void window.puppetloom.revealPath(project.projectDirectory)}><FolderOpen />{t("folder")}</button></div></article>)}</div></>}
    </div> : section === "source" ? <div className="production-source">
      <section className="source-task-column"><h2>{t("sourceStep1")}</h2><label><span>{t("originalCharacterImage")}</span><small>{reference || t("imageFormats")}</small></label><button className="with-icon" disabled={busy} onClick={async () => { const value = await window.puppetloom.chooseReference(); if (value) setReference(value); }}><FileImage />{t("chooseArtwork")}</button><label><span>{t("taskFolder")}</span><small>{taskDirectory || t("taskFolderEmpty")}</small></label><button className="with-icon" disabled={busy} onClick={async () => { const value = await window.puppetloom.chooseOutput(); if (value) setTaskDirectory(value); }}><FolderOutput />{t("chooseFolder")}</button><label><span>{t("characterName")}</span><input value={taskName} maxLength={80} placeholder={t("optional")} onChange={(event) => setTaskName(event.target.value)} /></label><button className="primary with-icon" disabled={busy || !reference || !taskDirectory} onClick={() => void createTask()}><ClipboardCheck />{t("createLayerTask")}</button>{task && <div className={`source-task-status ${task.status}`}><strong>{task.name}</strong><span>{task.status}</span><small>{t("candidateVersions", { count: task.reviews.length })}</small></div>}</section>
      <section className="source-review-column"><h2>{t("sourceStep2")}</h2><label><span>{t("existingTaskFolder")}</span><small>{taskDirectory || t("existingTaskHint")}</small></label><button className="with-icon" disabled={busy} onClick={() => void chooseDirectory(setTaskDirectory)}><FolderOpen />{t("openTask")}</button><label><span>{t("candidatePsd")}</span><small>{candidate || t("candidatePsdHint")}</small></label><button className="with-icon" disabled={busy} onClick={async () => { const value = await window.puppetloom.choosePsd(); if (value) setCandidate(value); }}><FileImage />{t("choosePsd")}</button><button className="primary with-icon" disabled={busy || !taskDirectory || !candidate} onClick={() => void inspectCandidate()}><ScanSearch />{busy ? t("makingEvidence") : t("saveAndReview")}</button>{review && <div className={`review-result ${review.blockers.length ? "blocked" : "ready"}`}>{review.blockers.length ? <TriangleAlert /> : <CheckCircle2 />}<strong>{review.blockers.length ? t("structureBlocked", { count: review.blockers.length }) : t("structurePassed")}</strong>{review.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}<button className="with-icon" onClick={() => void window.puppetloom.revealPath(review.reviewDirectory)}><FolderOpen />{t("viewAllEvidence")}</button></div>}</section>
      <section className="source-evidence-column"><h2>{t("sourceStep3")}</h2>{comparisonUrl ? <img src={comparisonUrl} alt={t("comparisonAlt")} /> : <div className="production-empty compact"><FileImage /><strong>{t("waitingCandidateTitle")}</strong><span>{t("waitingCandidateBody")}</span></div>}{review && <><div className="decision-choice"><button className={decision === "ready" ? "active" : ""} disabled={review.blockers.length > 0} onClick={() => setDecision("ready")}><CheckCircle2 />{t("canCreate")}</button><button className={decision === "needs-repair" ? "active" : ""} onClick={() => setDecision("needs-repair")}><TriangleAlert />{t("needsRepair")}</button></div><label><span>{t("visualConclusion")}</span><textarea value={decisionNote} placeholder={t("visualPlaceholder")} onChange={(event) => setDecisionNote(event.target.value)} /></label><button className="primary with-icon" disabled={busy || !decisionNote.trim()} onClick={() => void finalize()}><ClipboardCheck />{t("saveConclusion")}</button></>}</section>
    </div> : <div className="production-system">
      <section className="language-settings"><strong>{t("language")}</strong><small>{t("languageHint")}</small><LanguageSwitcher /></section>
      <section className="production-controls"><div><strong>{t("localEnvironment")}</strong><small>{t("localEnvironmentHint")}</small></div><button className="primary with-icon" disabled={busy} onClick={() => void inspectSystem()}><RefreshCw />{busy ? t("checking") : t("recheck")}</button></section>
      {environment && <div className="environment-checks">{environment.checks.map((check) => <article className={check.status} key={check.id}>{check.status === "passed" ? <CheckCircle2 /> : <TriangleAlert />}<div><strong>{check.label}</strong><span>{check.message}</span>{check.value && <small>{check.value}</small>}</div></article>)}</div>}
      {update && <section className="update-card"><div><strong>{t("appUpdate")}</strong><span>{update.message}</span><small>{t("currentVersion", { version: update.currentVersion })}{update.manifest ? t("availableVersion", { version: update.manifest.version }) : ""}</small></div>{update.available && !update.installer && <button className="primary with-icon" disabled={busy} onClick={async () => { setBusy(true); try { setUpdate(await window.puppetloom.updateDownload()); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); } }}><Download />{t("downloadUpdate")}</button>}{update.installer && <button className="primary with-icon" onClick={() => void window.puppetloom.updateInstall(update.installer!)}><Download />{t("quitAndInstall")}</button>}</section>}
    </div>}
    {error && <div className="error production-error" role="alert">{error}</div>}
  </section>;
}
