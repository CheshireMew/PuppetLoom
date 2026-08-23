from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
import secrets
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFont, ImageOps, ImageStat
from psd_tools import PSDImage

from finalize_psd_review import ReviewFinalizationError, finalize_review


DEFAULT_SERVICE_URL = "https://ljsabc-see-through.ms.show"
ENDPOINT_NAME = "/inference"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
MANUAL_URL = "https://modelscope.cn/studios/ljsabc/See-Through/?st=1WIdxVcPQ8ylM43-0Vr14FQ"
MAX_INFERENCE_ATTEMPTS = 2


class AcquisitionError(RuntimeError):
    pass


def _json_request(url: str, *, payload: Any | None = None, timeout: int) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _upload(service_url: str, image_path: Path, timeout: int) -> str:
    boundary = f"----PuppetLoom{secrets.token_hex(12)}"
    mime_type = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
    prefix = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="files"; filename="{image_path.name}"\r\n'
        f"Content-Type: {mime_type}\r\n\r\n"
    ).encode("utf-8")
    suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
    body = prefix + image_path.read_bytes() + suffix
    request = urllib.request.Request(
        f"{service_url}/gradio_api/upload",
        data=body,
        headers={"User-Agent": USER_AGENT},
    )
    request.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    request.add_header("Accept", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not isinstance(result, list) or not result or not isinstance(result[0], str):
        raise AcquisitionError(f"Unexpected upload response: {result!r}")
    return result[0]


def _read_sse(url: str, timeout: int) -> Any:
    request = urllib.request.Request(url, headers={"Accept": "text/event-stream", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        event_name = ""
        data_lines: list[str] = []
        while True:
            raw_line = response.readline()
            if not raw_line:
                break
            line = raw_line.decode("utf-8").rstrip("\r\n")
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            elif not line:
                data_text = "\n".join(data_lines)
                if event_name == "error":
                    raise AcquisitionError(data_text or "See-Through inference failed")
                if event_name == "complete":
                    try:
                        return json.loads(data_text)
                    except json.JSONDecodeError as error:
                        raise AcquisitionError(f"Invalid completion payload: {data_text}") from error
                event_name = ""
                data_lines = []
    raise AcquisitionError("See-Through event stream ended without a complete result")


def _remote_url(service_url: str, value: Any) -> str:
    if isinstance(value, dict):
        candidate = value.get("url") or value.get("path")
    else:
        candidate = value
    if not isinstance(candidate, str) or not candidate:
        raise AcquisitionError(f"Missing downloadable URL in output: {value!r}")
    parsed = urllib.parse.urlparse(candidate)
    if parsed.hostname in {"localhost", "127.0.0.1", "0.0.0.0"}:
        base = urllib.parse.urlparse(service_url)
        candidate = urllib.parse.urlunparse((base.scheme, base.netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))
    return urllib.parse.urljoin(f"{service_url}/", candidate)


def _download(url: str, destination: Path, timeout: int) -> None:
    request = urllib.request.Request(url, headers={"Accept": "*/*", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response, destination.open("xb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)


def _validate_psd(path: Path) -> None:
    if path.stat().st_size <= 4 or path.read_bytes()[:4] != b"8BPS":
        raise AcquisitionError(f"Downloaded file is not a valid PSD container: {path}")


def _check_api(service_url: str, timeout: int) -> dict[str, Any]:
    info = _json_request(f"{service_url}/gradio_api/info", timeout=timeout)
    endpoint = info.get("named_endpoints", {}).get(ENDPOINT_NAME)
    if not isinstance(endpoint, dict):
        raise AcquisitionError(f"Named endpoint {ENDPOINT_NAME} is unavailable")
    parameter_names = [item.get("parameter_name") for item in endpoint.get("parameters", [])]
    return_labels = [item.get("label") for item in endpoint.get("returns", [])]
    expected_parameters = ["image", "resolution", "seed", "tblr_split"]
    if parameter_names != expected_parameters or len(return_labels) < 2:
        raise AcquisitionError(
            f"See-Through API contract changed: parameters={parameter_names!r}, returns={return_labels!r}"
        )
    return {
        "ok": True,
        "serviceUrl": service_url,
        "endpoint": ENDPOINT_NAME,
        "parameters": parameter_names,
        "returns": return_labels,
    }


def _new_run_directory(output_root: Path) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{secrets.token_hex(3)}"
    run_directory = output_root / run_id
    run_directory.mkdir()
    return run_directory


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _exclusive_copy(source: Path, destination: Path) -> None:
    with source.open("rb") as input_file, destination.open("xb") as output_file:
        shutil.copyfileobj(input_file, output_file, length=1024 * 1024)


def _prepare_source(image_path: Path, run_directory: Path, canvas_size: tuple[int, int]) -> dict[str, Any]:
    suffix = image_path.suffix.lower() or ".image"
    source_copy = run_directory / f"source-original{suffix}"
    _exclusive_copy(image_path, source_copy)

    with Image.open(source_copy) as opened:
        source = ImageOps.exif_transpose(opened)
        source_mode = source.mode
        width, height = source.size
        if width <= 0 or height <= 0:
            raise AcquisitionError("Input image has invalid dimensions")
        source_rgba = source.convert("RGBA")
        alpha = source_rgba.getchannel("A")
        alpha_min, alpha_max = alpha.getextrema()
        source_rgb = Image.alpha_composite(Image.new("RGBA", source.size, (255, 255, 255, 255)), source_rgba).convert("RGB")
        source_upload_path = run_directory / "source-upload.png"
        source_rgb.save(source_upload_path)
        square_side = max(width, height)
        square = Image.new("RGB", (square_side, square_side), (255, 255, 255))
        offset = ((square_side - width) // 2, (square_side - height) // 2)
        square.paste(source_rgb, offset)
        normalized = square.resize(canvas_size, Image.Resampling.LANCZOS)
        normalized_path = run_directory / "source-normalized.png"
        normalized.save(normalized_path)

    return {
        "originalPath": str(image_path),
        "sourceOriginal": str(source_copy),
        "sourceUpload": str(source_upload_path),
        "sourceNormalized": str(normalized_path),
        "sha256": _sha256(source_copy),
        "uploadSha256": _sha256(source_upload_path),
        "normalizedSha256": _sha256(normalized_path),
        "bytes": source_copy.stat().st_size,
        "uploadBytes": source_upload_path.stat().st_size,
        "normalizedBytes": normalized_path.stat().st_size,
        "mode": source_mode,
        "dimensions": {"width": width, "height": height},
        "opaque": alpha_min == 255 and alpha_max == 255,
        "uploadOpaque": True,
        "uploadPreparation": "EXIF-corrected image composited on opaque white without resizing; this exact PNG is sent to See-Through",
        "normalizedCanvas": {"width": canvas_size[0], "height": canvas_size[1]},
        "normalization": "source-upload.png centered on a square white canvas followed by Lanczos resize",
    }


def _slugify_caption(value: Any, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or fallback


def _download_previews(gallery_value: Any, service_url: str, run_directory: Path, timeout: int) -> list[dict[str, Any]]:
    preview_records: list[dict[str, Any]] = []
    previews_directory = run_directory / "previews"
    previews_directory.mkdir(exist_ok=True)
    if isinstance(gallery_value, list):
        for index, gallery_item in enumerate(gallery_value, start=1):
            file_value = gallery_item.get("image") if isinstance(gallery_item, dict) else gallery_item
            caption = gallery_item.get("caption") if isinstance(gallery_item, dict) else None
            try:
                remote_url = _remote_url(service_url, file_value)
            except AcquisitionError:
                continue
            extension = Path(urllib.parse.urlparse(remote_url).path).suffix.lower()
            if extension not in {".png", ".jpg", ".jpeg", ".webp"}:
                extension = ".png"
            slug = _slugify_caption(caption, f"layer-{index:03d}")
            preview_path = previews_directory / f"{index:03d}-{slug}{extension}"
            _download(remote_url, preview_path, timeout)
            preview_records.append({"index": index, "caption": caption, "path": str(preview_path)})
    _write_json(previews_directory / "index.json", {"items": preview_records})
    return preview_records


def _export_local_psd_previews(psd_path: Path, run_directory: Path) -> list[dict[str, Any]]:
    psd = PSDImage.open(psd_path)
    previews_directory = run_directory / "previews"
    previews_directory.mkdir(exist_ok=True)
    preview_records: list[dict[str, Any]] = []

    def visit(container: Any, parent_path: list[str]) -> None:
        for layer in container:
            layer_name = str(layer.name or "unnamed-layer")
            source_path = [*parent_path, layer_name]
            if layer.is_group():
                visit(layer, source_path)
                continue
            preview = layer.composite(
                viewport=(0, 0, psd.width, psd.height),
                force=True,
                color=0.0,
                alpha=0.0,
            )
            if preview is None:
                continue
            index = len(preview_records) + 1
            caption = " / ".join(source_path)
            preview_path = previews_directory / f"{index:03d}-{_slugify_caption(caption, f'layer-{index:03d}')}.png"
            preview.convert("RGBA").save(preview_path)
            preview_records.append(
                {
                    "index": index,
                    "caption": caption,
                    "sourcePath": source_path,
                    "visible": bool(layer.is_visible()),
                    "path": str(preview_path),
                }
            )

    visit(psd, [])
    _write_json(
        previews_directory / "index.json",
        {
            "items": preview_records,
            "note": "Previews were deterministically rendered from the local PSD layer tree on the full PSD canvas.",
        },
    )
    return preview_records


def _preview_contact_sheet(preview_records: list[dict[str, Any]], run_directory: Path) -> str | None:
    if not preview_records:
        return None
    columns = 4
    image_size = 256
    label_height = 42
    cell_padding = 12
    cell_width = image_size + cell_padding * 2
    cell_height = image_size + label_height + cell_padding * 2
    rows = (len(preview_records) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * cell_width, rows * cell_height), (10, 13, 20))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=18)
    except TypeError:
        font = ImageFont.load_default()
    for item_index, record in enumerate(preview_records):
        column = item_index % columns
        row = item_index // columns
        cell_x = column * cell_width
        cell_y = row * cell_height
        with Image.open(record["path"]) as opened_preview:
            preview = opened_preview.convert("RGBA")
        preview.thumbnail((image_size, image_size), Image.Resampling.LANCZOS)
        background = Image.new("RGBA", (image_size, image_size), (24, 30, 44, 255))
        offset = ((image_size - preview.width) // 2, (image_size - preview.height) // 2)
        background.alpha_composite(preview, offset)
        sheet.paste(background.convert("RGB"), (cell_x + cell_padding, cell_y + cell_padding))
        caption = record.get("caption") or f"layer {record['index']}"
        draw.text(
            (cell_x + cell_padding, cell_y + cell_padding + image_size + 8),
            f"{record['index']:03d} {caption}",
            fill=(242, 245, 255),
            font=font,
        )
    contact_sheet_path = run_directory / "previews" / "contact-sheet.png"
    sheet.save(contact_sheet_path)
    return str(contact_sheet_path)


def _labeled_panel(image: Image.Image, label: str) -> Image.Image:
    header_height = 42
    panel = Image.new("RGB", (image.width, image.height + header_height), (14, 18, 28))
    panel.paste(image.convert("RGB"), (0, header_height))
    draw = ImageDraw.Draw(panel)
    try:
        font = ImageFont.load_default(size=22)
    except TypeError:
        font = ImageFont.load_default()
    draw.text((12, 9), label, fill=(245, 247, 255), font=font)
    return panel


def _create_review_evidence(source_normalized: Path, psd_path: Path, run_directory: Path) -> dict[str, Any]:
    psd = PSDImage.open(psd_path)
    with Image.open(source_normalized) as opened_source:
        normalized = opened_source.convert("RGB")
    if psd.size != normalized.size:
        raise AcquisitionError(f"PSD canvas {psd.size} does not match normalized source {normalized.size}")

    recomposed = psd.composite(force=True, color=0.0, alpha=0.0, ignore_preview=True)
    if recomposed is None:
        raise AcquisitionError("PSD visible layers could not be recomposed")
    recomposed = recomposed.convert("RGBA")
    recomposition_path = run_directory / "recomposition.png"
    recomposed.save(recomposition_path)

    light = Image.alpha_composite(Image.new("RGBA", recomposed.size, (255, 255, 255, 255)), recomposed).convert("RGB")
    dark = Image.alpha_composite(Image.new("RGBA", recomposed.size, (18, 22, 32, 255)), recomposed).convert("RGB")
    alpha = recomposed.getchannel("A")
    difference = ImageChops.difference(normalized, light)
    amplified = ImageEnhance.Brightness(difference).enhance(4.0)
    amplified_difference = Image.composite(amplified, Image.new("RGB", recomposed.size, (0, 0, 0)), alpha)
    difference_path = run_directory / "difference.png"
    amplified_difference.save(difference_path)

    panels = [
        _labeled_panel(normalized, "Normalized source"),
        _labeled_panel(light, "Visible PSD layers on white"),
        _labeled_panel(dark, "Visible PSD layers on dark"),
        _labeled_panel(amplified_difference, "Difference x4 (not an acceptance score)"),
    ]
    comparison = Image.new("RGB", (panels[0].width * 2, panels[0].height * 2), (14, 18, 28))
    comparison.paste(panels[0], (0, 0))
    comparison.paste(panels[1], (panels[0].width, 0))
    comparison.paste(panels[2], (0, panels[0].height))
    comparison.paste(panels[3], (panels[0].width, panels[0].height))
    comparison_path = run_directory / "comparison.png"
    comparison.save(comparison_path)

    alpha_histogram = alpha.histogram()
    visible_pixels = sum(alpha_histogram[1:])
    difference_statistics = ImageStat.Stat(difference, mask=alpha)
    metrics = {
        "canvas": {"width": recomposed.width, "height": recomposed.height},
        "visiblePixelCount": visible_pixels,
        "alphaBoundingBox": alpha.getbbox(),
        "meanAbsoluteRgbDifferenceWithinVisibleAlpha": [round(value, 4) for value in difference_statistics.mean],
        "maximumRgbDifference": [value[1] for value in difference.getextrema()],
        "automaticDecision": None,
        "warning": "Metrics help locate differences but must never accept or reject a PSD without visual review.",
    }
    metrics_path = run_directory / "comparison-metrics.json"
    _write_json(metrics_path, metrics)

    visual_review = {
        "status": "pending-agent-review",
        "acceptedForNextStage": None,
        "reviewedAt": None,
        "reviewer": None,
        "blockingIssues": [],
        "repairPlan": [],
        "requiredViews": {
            "sourceNormalized": str(source_normalized),
            "recomposition": str(recomposition_path),
            "comparison": str(comparison_path),
            "previewIndex": str(run_directory / "previews" / "index.json"),
            "previewContactSheet": str(run_directory / "previews" / "contact-sheet.png")
            if (run_directory / "previews" / "contact-sheet.png").is_file()
            else None,
        },
        "checks": [
            {"id": "face-and-eyes", "status": None, "question": "Are the face, both eyes, irises, eyelashes, brows, nose, and mouth present and aligned?"},
            {"id": "hair-and-headwear", "status": None, "question": "Are front hair, back hair, ears, and headwear complete without white residue or missing edges?"},
            {"id": "clothing-and-limbs", "status": None, "question": "Are clothing details, arms, hands, legs, feet, tail, and accessories complete and clean?"},
            {"id": "layer-order-and-occlusion", "status": None, "question": "Does the back-to-front order match the source, including back skirt behind exposed legs, back hair behind neck and face, and brows in front of the face?"},
            {"id": "background-and-alpha", "status": None, "question": "Are transparent edges clean on both light and dark backgrounds, without detached noise or retained background?"},
            {"id": "overall-recomposition", "status": None, "question": "Does the visible-layer recomposition preserve the normalized source on the same canvas?"},
        ],
        "notes": [],
        "rule": "The external Agent must open the required images, set every check to pass, repair, fail, or not-applicable, and record accepted, accepted-with-repairs, or rejected before finalizing through the wrapper. Independent layer-order defects may be repaired through a recorded move-layer plan; merged front/back content is a blocker. Structural inspect and numeric metrics cannot decide this.",
    }
    visual_review_path = run_directory / "visual-review.json"
    _write_json(visual_review_path, visual_review)
    return {
        "recomposition": str(recomposition_path),
        "difference": str(difference_path),
        "comparison": str(comparison_path),
        "metrics": str(metrics_path),
        "visualReview": str(visual_review_path),
        "recompositionMethod": "psd_tools.PSDImage.composite(force=True, ignore_preview=True)",
    }


def _run_puppetloom_inspect(psd_path: Path, run_directory: Path, timeout: int) -> dict[str, Any]:
    powershell = shutil.which("powershell.exe") or shutil.which("pwsh.exe")
    wrapper = Path(__file__).resolve().with_name("invoke_puppetloom.ps1")
    if not powershell or not wrapper.is_file():
        raise AcquisitionError("PuppetLoom inspect wrapper is unavailable")
    completed = subprocess.run(
        [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(wrapper),
            "inspect",
            "--input",
            str(psd_path),
            "--json",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        raise AcquisitionError(f"PuppetLoom inspect failed: {completed.stderr.strip() or completed.stdout.strip()}")
    try:
        report = json.loads(completed.stdout.lstrip("\ufeff").strip())
    except json.JSONDecodeError as error:
        raise AcquisitionError(f"PuppetLoom inspect returned invalid JSON: {completed.stdout[:500]}") from error
    _write_json(run_directory / "inspect.json", report)
    if not report.get("valid"):
        raise AcquisitionError("PuppetLoom rejected the downloaded PSD")
    return report


def _is_retryable_transport_error(error: Exception) -> bool:
    if isinstance(error, (TimeoutError, ConnectionError, urllib.error.URLError)):
        return True
    message = str(error).lower()
    return any(
        phrase in message
        for phrase in (
            "event stream ended without a complete result",
            "timed out",
            "connection reset",
            "remote end closed connection",
            "temporarily unavailable",
            "incomplete read",
        )
    )


def _run_inference_with_retry(
    service_url: str,
    image_path: Path,
    resolution: int,
    seed: int,
    split_limbs: bool,
    timeout: int,
    run_directory: Path,
) -> Any:
    attempts_directory = run_directory / "attempts"
    attempts_directory.mkdir(exist_ok=True)
    attempt_records: list[dict[str, Any]] = []
    for attempt_number in range(1, MAX_INFERENCE_ATTEMPTS + 1):
        attempt_directory = attempts_directory / f"attempt-{attempt_number}"
        attempt_directory.mkdir()
        started_at = datetime.now(timezone.utc).isoformat()
        try:
            uploaded_path = _upload(service_url, image_path, timeout)
            _write_json(attempt_directory / "upload.json", {"path": uploaded_path, "source": str(image_path)})
            input_data = {
                "path": uploaded_path,
                "orig_name": image_path.name,
                "size": image_path.stat().st_size,
                "mime_type": mimetypes.guess_type(image_path.name)[0] or "application/octet-stream",
                "is_stream": False,
                "meta": {"_type": "gradio.FileData"},
            }
            submission = _json_request(
                f"{service_url}/gradio_api/call/inference",
                payload={"data": [input_data, resolution, seed, split_limbs]},
                timeout=timeout,
            )
            event_id = submission.get("event_id") if isinstance(submission, dict) else None
            if not event_id:
                raise AcquisitionError(f"Missing event_id in submission response: {submission!r}")
            _write_json(attempt_directory / "submission.json", submission)
            response_data = _read_sse(
                f"{service_url}/gradio_api/call/inference/{urllib.parse.quote(str(event_id), safe='')}",
                timeout,
            )
            if not isinstance(response_data, list) or len(response_data) < 2:
                raise AcquisitionError(f"Unexpected inference result: {response_data!r}")
            _write_json(attempt_directory / "response.json", response_data)
            record = {
                "attempt": attempt_number,
                "ok": True,
                "startedAt": started_at,
                "finishedAt": datetime.now(timezone.utc).isoformat(),
                "directory": str(attempt_directory),
            }
            _write_json(attempt_directory / "result.json", record)
            attempt_records.append(record)
            _write_json(attempts_directory / "index.json", {"attempts": attempt_records})
            _write_json(run_directory / "submission.json", submission)
            _write_json(run_directory / "response.json", response_data)
            return response_data
        except Exception as error:
            retryable = _is_retryable_transport_error(error)
            record = {
                "attempt": attempt_number,
                "ok": False,
                "retryable": retryable,
                "startedAt": started_at,
                "finishedAt": datetime.now(timezone.utc).isoformat(),
                "directory": str(attempt_directory),
                "errorType": type(error).__name__,
                "error": str(error),
            }
            _write_json(attempt_directory / "result.json", record)
            attempt_records.append(record)
            _write_json(attempts_directory / "index.json", {"attempts": attempt_records})
            if attempt_number >= MAX_INFERENCE_ATTEMPTS or not retryable:
                raise
    raise AcquisitionError("See-Through inference exhausted all attempts")


def _inspect_summary(report: dict[str, Any]) -> dict[str, Any]:
    return {
        "valid": report.get("valid"),
        "canvas": report.get("canvas"),
        "visibleLayerCount": report.get("visibleLayerCount"),
        "recognizedLayerCount": report.get("recognizedLayerCount"),
        "suggestedRigLevel": report.get("suggestedRigLevel"),
        "warnings": report.get("warnings", []),
    }


def acquire(args: argparse.Namespace) -> dict[str, Any]:
    service_url = args.service_url.rstrip("/")
    image_path = Path(args.input_image).resolve(strict=True)
    if not image_path.is_file():
        raise AcquisitionError(f"Input image is not a file: {image_path}")
    if not 768 <= args.resolution <= 1600:
        raise AcquisitionError("Resolution must be between 768 and 1600")
    if not 0 <= args.seed <= 9999:
        raise AcquisitionError("Seed must be between 0 and 9999")

    run_directory = _new_run_directory(Path(args.output_root).resolve())
    request_record = {
        "operation": "acquire-from-see-through",
        "serviceUrl": service_url,
        "endpoint": ENDPOINT_NAME,
        "inputImage": str(image_path),
        "resolution": args.resolution,
        "seed": args.seed,
        "splitLimbs": args.split_limbs,
        "maximumTransportAttempts": MAX_INFERENCE_ATTEMPTS,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    _write_json(run_directory / "request.json", request_record)
    source_record: dict[str, Any] | None = None
    try:
        source_record = _prepare_source(image_path, run_directory, (args.resolution, args.resolution))
        request_record["source"] = source_record
        _write_json(run_directory / "request.json", request_record)
        _check_api(service_url, args.timeout)
        response_data = _run_inference_with_retry(
            service_url,
            Path(source_record["sourceUpload"]),
            args.resolution,
            args.seed,
            args.split_limbs,
            args.timeout,
            run_directory,
        )

        psd_value, gallery_value = response_data[0], response_data[1]
        psd_name = "layered.psd"
        if isinstance(psd_value, dict) and isinstance(psd_value.get("orig_name"), str):
            candidate_name = Path(psd_value["orig_name"]).name
            if candidate_name.lower().endswith(".psd"):
                psd_name = candidate_name
        psd_path = run_directory / psd_name
        _download(_remote_url(service_url, psd_value), psd_path, args.timeout)
        _validate_psd(psd_path)
        preview_records = _download_previews(gallery_value, service_url, run_directory, args.timeout)
        preview_contact_sheet = _preview_contact_sheet(preview_records, run_directory)
        inspect_report = _run_puppetloom_inspect(psd_path, run_directory, args.timeout)
        review_evidence = _create_review_evidence(Path(source_record["sourceNormalized"]), psd_path, run_directory)

        result = {
            "ok": True,
            "stage": "psd-review-evidence-generated",
            "scopeBoundary": "PSD-only: stop before PuppetLoom create, project creation, or rig specification unless the user explicitly asks to continue.",
            "readyForCreate": False,
            "runDirectory": str(run_directory),
            "source": source_record,
            "psd": str(psd_path),
            "psdBytes": psd_path.stat().st_size,
            "psdSha256": _sha256(psd_path),
            "previews": preview_records,
            "previewIndex": str(run_directory / "previews" / "index.json"),
            "previewContactSheet": preview_contact_sheet,
            "inspect": str(run_directory / "inspect.json"),
            "inspectSummary": _inspect_summary(inspect_report),
            "reviewEvidence": review_evidence,
            "request": str(run_directory / "request.json"),
            "response": str(run_directory / "response.json"),
            "attempts": str(run_directory / "attempts" / "index.json"),
            "next": "Open the normalized source, visible-layer recomposition, comparison sheet, and relevant layer previews; record accepted, accepted-with-repairs, or rejected in visual-review.json, then finalize it through the wrapper. Structural inspect or numeric metrics cannot accept the PSD.",
        }
        _write_json(run_directory / "result.json", result)
        return result
    except Exception as error:
        failure = {
            "ok": False,
            "runDirectory": str(run_directory),
            "source": source_record,
            "errorType": type(error).__name__,
            "error": str(error),
            "manualUrl": MANUAL_URL,
        }
        _write_json(run_directory / "result.json", failure)
        raise AcquisitionError(json.dumps(failure, ensure_ascii=False)) from error


def review_existing(args: argparse.Namespace) -> dict[str, Any]:
    image_path = Path(args.input_image).resolve(strict=True)
    psd_input = Path(args.review_psd).resolve(strict=True)
    if not image_path.is_file() or not psd_input.is_file():
        raise AcquisitionError("Local review requires an image file and a PSD file")
    run_directory = _new_run_directory(Path(args.output_root).resolve())
    request_record = {
        "operation": "review-existing-psd",
        "inputImage": str(image_path),
        "inputPsd": str(psd_input),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    _write_json(run_directory / "request.json", request_record)
    source_record: dict[str, Any] | None = None
    try:
        psd_path = run_directory / "layered.psd"
        _exclusive_copy(psd_input, psd_path)
        _validate_psd(psd_path)
        psd = PSDImage.open(psd_path)
        source_record = _prepare_source(image_path, run_directory, psd.size)
        request_record["source"] = source_record
        request_record["psdSha256"] = _sha256(psd_path)
        _write_json(run_directory / "request.json", request_record)
        preview_records = _export_local_psd_previews(psd_path, run_directory)
        preview_contact_sheet = _preview_contact_sheet(preview_records, run_directory)
        previews_directory = run_directory / "previews"
        inspect_report = _run_puppetloom_inspect(psd_path, run_directory, args.timeout)
        review_evidence = _create_review_evidence(Path(source_record["sourceNormalized"]), psd_path, run_directory)
        result = {
            "ok": True,
            "stage": "local-psd-review-evidence-generated",
            "scopeBoundary": "PSD-only: stop before PuppetLoom create, project creation, or rig specification unless the user explicitly asks to continue.",
            "readyForCreate": False,
            "runDirectory": str(run_directory),
            "source": source_record,
            "psd": str(psd_path),
            "psdBytes": psd_path.stat().st_size,
            "psdSha256": _sha256(psd_path),
            "previews": preview_records,
            "previewIndex": str(previews_directory / "index.json"),
            "previewContactSheet": preview_contact_sheet,
            "inspect": str(run_directory / "inspect.json"),
            "inspectSummary": _inspect_summary(inspect_report),
            "reviewEvidence": review_evidence,
            "request": str(run_directory / "request.json"),
            "next": "Open the required review images and record accepted, accepted-with-repairs, or rejected in visual-review.json, then finalize it through the wrapper. Do not create a project for a PSD-only request.",
        }
        _write_json(run_directory / "result.json", result)
        return result
    except Exception as error:
        failure = {
            "ok": False,
            "runDirectory": str(run_directory),
            "source": source_record,
            "errorType": type(error).__name__,
            "error": str(error),
            "manualUrl": MANUAL_URL,
        }
        _write_json(run_directory / "result.json", failure)
        raise AcquisitionError(json.dumps(failure, ensure_ascii=False)) from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Acquire or locally review a layered PSD for PuppetLoom.")
    parser.add_argument("input_image", nargs="?", help="Approved local character image to upload")
    parser.add_argument("--resolution", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--split-limbs", action="store_true")
    parser.add_argument("--output-root", default=str(Path(__file__).resolve().parents[1] / "runtime" / "see-through"))
    parser.add_argument("--service-url", default=DEFAULT_SERVICE_URL)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--check", action="store_true", help="Validate the public API contract without uploading a file")
    parser.add_argument("--review-psd", help="Review an existing local PSD against input_image without uploading anything")
    parser.add_argument("--finalize-review", help="Validate visual-review.json and synchronize its decision into result.json")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.check and args.finalize_review:
            parser.error("--check and --finalize-review are mutually exclusive")
        if args.check:
            result = _check_api(args.service_url.rstrip("/"), args.timeout)
        elif args.finalize_review:
            if args.input_image or args.review_psd:
                parser.error("input_image and --review-psd cannot be used with --finalize-review")
            result = finalize_review(args.finalize_review)
        else:
            if not args.input_image:
                parser.error("input_image is required unless --check is used")
            result = review_existing(args) if args.review_psd else acquire(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (AcquisitionError, ReviewFinalizationError, OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "errorType": type(error).__name__, "error": str(error)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
