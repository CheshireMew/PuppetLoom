import { useCallback, useEffect, useRef } from "react";
import type { CalibrationOverrides } from "@puppetloom/core";

type DraftStatus = "idle" | "waiting" | "saving" | "saved" | "error";

export function useEditorDraftPersistence({
  projectDirectory,
  revision,
  pending,
  label,
  busy,
  setDraftStatus,
  setError
}: {
  projectDirectory: string;
  revision: number | undefined;
  pending: CalibrationOverrides;
  label: string;
  busy: boolean;
  setDraftStatus: (status: DraftStatus) => void;
  setError: (message: string) => void;
}) {
  const pendingRef = useRef<CalibrationOverrides>(pending);
  const labelRef = useRef(label);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  pendingRef.current = pending;
  labelRef.current = label;

  const cancelScheduled = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const flushDraft = useCallback(async (): Promise<void> => {
    cancelScheduled();
    if (revision === undefined) return;
    setDraftStatus("saving");
    try {
      await window.puppetloom.saveCalibrationDraft(projectDirectory, revision, pendingRef.current, labelRef.current);
      setDraftStatus("saved");
    } catch (cause) {
      setDraftStatus("error");
      throw cause;
    }
  }, [cancelScheduled, projectDirectory, revision, setDraftStatus]);

  useEffect(() => {
    if (revision === undefined || busy) return;
    cancelScheduled();
    const selectedGeneration = ++generation.current;
    setDraftStatus("waiting");
    timer.current = setTimeout(() => {
      setDraftStatus("saving");
      void window.puppetloom.saveCalibrationDraft(projectDirectory, revision, pendingRef.current, labelRef.current).then(() => {
        if (generation.current === selectedGeneration) setDraftStatus("saved");
      }).catch((cause) => {
        if (generation.current === selectedGeneration) {
          setDraftStatus("error");
          setError(`自动保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      });
    }, 350);
    return cancelScheduled;
  }, [busy, cancelScheduled, label, pending, projectDirectory, revision, setDraftStatus, setError]);

  useEffect(() => window.puppetloom.onPrepareEditorClose(async () => {
    try {
      await flushDraft();
      await window.puppetloom.confirmEditorClose();
    } catch (cause) {
      setError(`关闭前保存草稿失败，窗口已保持打开：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }), [flushDraft, setError]);

  return { pendingRef, cancelScheduled, flushDraft };
}
