from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class ReviewFinalizationError(RuntimeError):
    pass


def _read_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ReviewFinalizationError(f"{label} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise ReviewFinalizationError(f"{label} must contain a JSON object: {path}")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_write(path: Path, value: Any) -> None:
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _file(value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ReviewFinalizationError(f"{label} path is missing")
    path = Path(value).resolve(strict=True)
    if not path.is_file():
        raise ReviewFinalizationError(f"{label} is not a file: {path}")
    return path


def _validate_evidence(review_path: Path, review: dict[str, Any], result: dict[str, Any]) -> None:
    recorded_review = result.get("reviewEvidence", {}).get("visualReview")
    if not isinstance(recorded_review, str) or Path(recorded_review).resolve() != review_path:
        raise ReviewFinalizationError("result.json does not point to this visual-review.json")
    views = review.get("requiredViews")
    if not isinstance(views, dict):
        raise ReviewFinalizationError("visual-review.json is missing requiredViews")
    for key in ("sourceNormalized", "recomposition", "comparison", "previewIndex"):
        _file(views.get(key), f"requiredViews.{key}")
    if views.get("previewContactSheet") is not None:
        _file(views["previewContactSheet"], "requiredViews.previewContactSheet")

    psd = _file(result.get("psd"), "result.psd")
    if _sha256(psd) != result.get("psdSha256"):
        raise ReviewFinalizationError("PSD hash no longer matches result.json")
    source = result.get("source")
    if not isinstance(source, dict):
        raise ReviewFinalizationError("result.json is missing source provenance")
    original = _file(source.get("sourceOriginal"), "result.source.sourceOriginal")
    if _sha256(original) != source.get("sha256"):
        raise ReviewFinalizationError("Original source hash no longer matches result.json")


def finalize_review(review_value: str | Path) -> dict[str, Any]:
    review_path = Path(review_value).resolve(strict=True)
    if review_path.name.lower() != "visual-review.json":
        raise ReviewFinalizationError("--finalize-review must point to visual-review.json")
    result_path = review_path.parent / "result.json"
    if not result_path.is_file():
        raise ReviewFinalizationError(f"Matching result.json is missing: {result_path}")

    review = _read_object(review_path, "visual-review.json")
    result = _read_object(result_path, "result.json")
    if result.get("ok") is not True:
        raise ReviewFinalizationError("Only a successful PSD acquisition or local review can be finalized")
    _validate_evidence(review_path, review, result)

    status = review.get("status")
    allowed = {"accepted", "accepted-with-repairs", "rejected"}
    if status not in allowed:
        raise ReviewFinalizationError(f"Review status must be one of {sorted(allowed)}")
    blockers = review.get("blockingIssues", [])
    repairs = review.get("repairPlan", [])
    if not isinstance(blockers, list) or not isinstance(repairs, list):
        raise ReviewFinalizationError("blockingIssues and repairPlan must be arrays")
    if status != "rejected" and blockers:
        raise ReviewFinalizationError(f"{status} cannot contain blockingIssues")
    if status == "accepted" and repairs:
        raise ReviewFinalizationError("Use accepted-with-repairs when repairPlan is not empty")
    if status == "accepted-with-repairs" and not repairs:
        raise ReviewFinalizationError("accepted-with-repairs requires a non-empty repairPlan")
    if status == "rejected" and not blockers:
        raise ReviewFinalizationError("rejected requires at least one blocking issue")

    reviewed_at = review.get("reviewedAt")
    if not isinstance(reviewed_at, str) or not reviewed_at.strip():
        reviewed_at = datetime.now(timezone.utc).isoformat()
    reviewer = review.get("reviewer")
    if not isinstance(reviewer, str) or not reviewer.strip():
        reviewer = "external Agent"
    ready = status != "rejected"
    review.update(
        acceptedForNextStage=ready,
        reviewedAt=reviewed_at,
        reviewer=reviewer,
        rule="The external Agent visually decides accepted, accepted-with-repairs, or rejected. This finalized record is authoritative; structural inspect and numeric metrics cannot decide it.",
    )
    next_step = {
        "accepted": "PSD-only task complete. The reviewed PSD is ready if the user later asks to create a PuppetLoom project.",
        "accepted-with-repairs": "PSD-only task complete. Carry the recorded repair plan into any later project and complete it before final delivery.",
        "rejected": "PSD-only task complete. Do not create a project from this rejected candidate; repair the PSD or acquire another candidate.",
    }[status]
    result.update(
        stage="psd-visual-review-finalized",
        readyForCreate=ready,
        visualReviewStatus=status,
        blockingIssues=blockers,
        repairPlan=repairs,
        reviewedAt=reviewed_at,
        reviewer=reviewer,
        next=next_step,
    )
    _atomic_write(review_path, review)
    _atomic_write(result_path, result)
    return {
        "ok": True,
        "stage": "psd-visual-review-finalized",
        "runDirectory": str(review_path.parent),
        "status": status,
        "readyForCreate": ready,
        "visualReview": str(review_path),
        "result": str(result_path),
    }
