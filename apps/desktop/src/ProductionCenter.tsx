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
    catch (cause) { setError(`프로젝트 라이브러리 스캔에 실패함: ${messageOf(cause)}`); }
    finally { setBusy(false); }
  }

  async function createTask(): Promise<void> {
    if (!reference || !taskDirectory) return;
    setBusy(true); setError(""); setReview(undefined);
    try {
      const result = await window.puppetloom.prepareSourceTask({ reference, output: taskDirectory, ...(taskName.trim() ? { name: taskName.trim() } : {}) });
      setTask(result.task);
      setTaskDirectory(result.directory);
    } catch (cause) { setError(`소재 작업 만들기에 실패함: ${messageOf(cause)}`); }
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
    } catch (cause) { setError(`후보 PSD 검토에 실패함: ${messageOf(cause)}`); }
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
    } catch (cause) { setError(`소재 결론 저장에 실패함: ${messageOf(cause)}`); }
    finally { setBusy(false); }
  }

  async function inspectSystem(): Promise<void> {
    setBusy(true); setError("");
    try { const [doctor, updateStatus] = await Promise.all([window.puppetloom.environmentDoctor(), window.puppetloom.updateCheck()]); setEnvironment(doctor); setUpdate(updateStatus); }
    catch (cause) { setError(`환경 검사에 실패함: ${messageOf(cause)}`); }
    finally { setBusy(false); }
  }

  return <section className="production-center" data-testid="production-center">
    <header className="production-center-header"><div><span>제작 센터</span><h1>{section === "library" ? "캐릭터 프로젝트 라이브러리와 점검" : section === "source" ? "원화와 레이어 소재 준비" : "Windows 환경과 업데이트"}</h1><p>{section === "library" ? "프로젝트 파일, revision, 증거, 소재 능력, 녹화 상태를 한곳에서 확인합니다." : section === "source" ? "후보 버전과 시각 증거를 저장한 뒤, 확인된 PSD를 만들기로 넘깁니다." : "이 PC의 실행 조건을 확인하고, 명시적으로 선택한 뒤에만 새 버전을 다운로드하거나 설치합니다."}</p></div><button className="icon-only" aria-label="제작 센터 닫기" onClick={onClose}><X /></button></header>
    <nav className="production-tabs"><button className={section === "library" ? "active" : ""} onClick={() => setSection("library")}><FolderKanban />프로젝트 라이브러리</button><button className={section === "source" ? "active" : ""} onClick={() => setSection("source")}><FileImage />소재 준비</button><button className={section === "system" ? "active" : ""} onClick={() => { setSection("system"); if (!environment) void inspectSystem(); }}><Settings2 />환경과 업데이트</button></nav>
    {section === "library" ? <div className="production-library">
      <section className="production-controls"><label><span>프로젝트 라이브러리 루트</span><small>{libraryRoot || "캐릭터 프로젝트만 있는 이 PC 폴더를 선택"}</small></label><button className="with-icon" disabled={busy} onClick={() => void chooseDirectory(setLibraryRoot)}><FolderOpen />폴더 선택</button><button className="primary with-icon" disabled={busy || !libraryRoot} onClick={() => void scanLibrary()}><ScanSearch />{busy ? "점검 중…" : "전체 프로젝트 스캔"}</button></section>
      {!library && <div className="production-empty"><FolderKanban /><strong>프로젝트 라이브러리 스캔 대기</strong><span>스캔은 깊이와 프로젝트 수 상한이 있으며, 캐릭터는 수정하지 않습니다.</span></div>}
      {library && <><section className="library-summary"><div><span>프로젝트</span><strong>{library.summary.total}</strong></div><div><span>유효</span><strong>{library.summary.valid}</strong></div><div><span>처리 필요</span><strong>{library.summary.needsAttention}</strong></div><div><span>검수 대기 증거</span><strong>{library.summary.pendingEvidence}</strong></div><div><span>평균 점수</span><strong>{library.summary.averageScore}</strong></div></section><div className="production-project-list">{library.projects.map((project) => <article key={project.projectDirectory}><div className={`project-score ${scoreTone(project.score)}`}>{project.score}</div><div className="project-health-copy"><strong>{project.project}</strong><span>revision {project.revision} · {project.capabilities.rigLevel} · {project.capabilities.layers}레이어</span><small>{project.issues.filter((issue) => issue.severity !== "info").map((issue) => issue.message).join(" · ") || "파일, 증거, 제작 소재가 모두 준비됨"}</small></div><div className="project-health-actions"><button className="with-icon" onClick={() => onEdit(project.projectDirectory)}><ExternalLink />열기</button><button className="with-icon" onClick={() => void window.puppetloom.revealPath(project.projectDirectory)}><FolderOpen />폴더</button></div></article>)}</div></>}
    </div> : section === "source" ? <div className="production-source">
      <section className="source-task-column"><h2>1. 소재 작업 만들기</h2><label><span>원본 캐릭터 이미지</span><small>{reference || "PNG, JPG 또는 WebP"}</small></label><button className="with-icon" disabled={busy} onClick={async () => { const value = await window.puppetloom.chooseReference(); if (value) setReference(value); }}><FileImage />원화 선택</button><label><span>작업 폴더</span><small>{taskDirectory || "새 폴더 또는 빈 폴더를 선택"}</small></label><button className="with-icon" disabled={busy} onClick={async () => { const value = await window.puppetloom.chooseOutput(); if (value) setTaskDirectory(value); }}><FolderOutput />폴더 선택</button><label><span>캐릭터 이름</span><input value={taskName} maxLength={80} placeholder="선택" onChange={(event) => setTaskName(event.target.value)} /></label><button className="primary with-icon" disabled={busy || !reference || !taskDirectory} onClick={() => void createTask()}><ClipboardCheck />레이어 작업 만들기</button>{task && <div className={`source-task-status ${task.status}`}><strong>{task.name}</strong><span>{task.status}</span><small>후보 {task.reviews.length}버전</small></div>}</section>
      <section className="source-review-column"><h2>2. 후보 PSD 검토</h2><label><span>기존 작업 폴더</span><small>{taskDirectory || "기존 소재 작업을 바로 열 수 있음"}</small></label><button className="with-icon" disabled={busy} onClick={() => void chooseDirectory(setTaskDirectory)}><FolderOpen />작업 열기</button><label><span>후보 PSD</span><small>{candidate || "검토할 때마다 새 후보 버전으로 복사됨"}</small></label><button className="with-icon" disabled={busy} onClick={async () => { const value = await window.puppetloom.choosePsd(); if (value) setCandidate(value); }}><FileImage />PSD 선택</button><button className="primary with-icon" disabled={busy || !taskDirectory || !candidate} onClick={() => void inspectCandidate()}><ScanSearch />{busy ? "증거를 만드는 중…" : "후보 저장 후 검토"}</button>{review && <div className={`review-result ${review.blockers.length ? "blocked" : "ready"}`}>{review.blockers.length ? <TriangleAlert /> : <CheckCircle2 />}<strong>{review.blockers.length ? `구조 차단 ${review.blockers.length}건` : "자동 구조 검사 통과"}</strong>{review.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}<button className="with-icon" onClick={() => void window.puppetloom.revealPath(review.reviewDirectory)}><FolderOpen />전체 증거 보기</button></div>}</section>
      <section className="source-evidence-column"><h2>3. 육안 확인</h2>{comparisonUrl ? <img src={comparisonUrl} alt="원화와 PSD 재조합 나란히 비교" /> : <div className="production-empty compact"><FileImage /><strong>후보 증거 대기</strong><span>원화와 PSD 재조합을 나란히 비교해 보여 줍니다.</span></div>}{review && <><div className="decision-choice"><button className={decision === "ready" ? "active" : ""} disabled={review.blockers.length > 0} onClick={() => setDecision("ready")}><CheckCircle2 />만들 수 있음</button><button className={decision === "needs-repair" ? "active" : ""} onClick={() => setDecision("needs-repair")}><TriangleAlert />수정 필요</button></div><label><span>육안 결론</span><textarea value={decisionNote} placeholder="윤곽, 이목구비, 가림/받침, 가장자리, 캔버스 위치 검사 결과를 적으세요" onChange={(event) => setDecisionNote(event.target.value)} /></label><button className="primary with-icon" disabled={busy || !decisionNote.trim()} onClick={() => void finalize()}><ClipboardCheck />이 버전 결론 저장</button></>}</section>
    </div> : <div className="production-system">
      <section className="production-controls"><div><strong>이 PC 환경 검사</strong><small>현재 Windows와 프로젝트에 필요한 로컬 의존성만 확인합니다.</small></div><button className="primary with-icon" disabled={busy} onClick={() => void inspectSystem()}><RefreshCw />{busy ? "검사 중…" : "다시 검사"}</button></section>
      {environment && <div className="environment-checks">{environment.checks.map((check) => <article className={check.status} key={check.id}>{check.status === "passed" ? <CheckCircle2 /> : <TriangleAlert />}<div><strong>{check.label}</strong><span>{check.message}</span>{check.value && <small>{check.value}</small>}</div></article>)}</div>}
      {update && <section className="update-card"><div><strong>앱 업데이트</strong><span>{update.message}</span><small>현재 버전 {update.currentVersion}{update.manifest ? ` · 사용 가능 버전 ${update.manifest.version}` : ""}</small></div>{update.available && !update.installer && <button className="primary with-icon" disabled={busy} onClick={async () => { setBusy(true); try { setUpdate(await window.puppetloom.updateDownload()); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); } }}><Download />업데이트 다운로드</button>}{update.installer && <button className="primary with-icon" onClick={() => void window.puppetloom.updateInstall(update.installer!)}><Download />종료 후 설치</button>}</section>}
    </div>}
    {error && <div className="error production-error" role="alert">{error}</div>}
  </section>;
}
