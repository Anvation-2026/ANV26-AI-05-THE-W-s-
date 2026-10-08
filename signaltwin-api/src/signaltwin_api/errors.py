"""Errors as RFC 7807 problem+json with a `fix` written for end users.

Wording rules (the front end shows these as they are): say what went wrong and
how to fix it. No apologies, no stack traces, no jargon.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("signaltwin.errors")

PROBLEM_JSON = "application/problem+json"


class ApiError(Exception):
    """An expected, user-explainable failure."""

    def __init__(
        self,
        code: str,
        status: int,
        title: str,
        detail: str,
        fix: str,
        **extra: Any,
    ) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.status = status
        self.title = title
        self.detail = detail
        self.fix = fix
        self.extra = extra

    def problem(self, correlation_id: str | None = None) -> dict[str, Any]:
        p: dict[str, Any] = {
            "type": f"https://signaltwin.dev/problems/{self.code}",
            "code": self.code,
            "status": self.status,
            "title": self.title,
            "detail": self.detail,
            "fix": self.fix,
        }
        if correlation_id:
            p["correlationId"] = correlation_id
        p.update(self.extra)
        return p


# ----- constructors, one per documented code -------------------------------------------------


def unsupported_format(detail: str = "The file is not a video this service can read.") -> ApiError:
    return ApiError(
        "unsupported_format",
        415,
        "That file is not a supported video",
        detail,
        "Upload an MP4, MOV, MKV or WebM file that plays in a normal video player.",
    )


def video_too_large(size_mb: float, limit_mb: int) -> ApiError:
    return ApiError(
        "video_too_large",
        413,
        "The video is too large",
        f"The file is {size_mb:,.0f} MB. The limit is {limit_mb} MB.",
        "Trim the clip or lower its resolution, then upload again.",
        limitMb=limit_mb,
    )


def video_resolution_too_large(width: int, limit: int) -> ApiError:
    return ApiError(
        "video_too_large",
        413,
        "The video resolution is too high",
        f"The video is {width} pixels wide. The limit is {limit} pixels.",
        "Export the clip at 1920 pixels wide or less, then upload again.",
        limitWidth=limit,
    )


def video_too_short(duration_s: float, minimum: float = 3.0) -> ApiError:
    return ApiError(
        "video_too_short",
        422,
        "The video is too short",
        f"The video is {duration_s:.1f} s long. At least {minimum:.0f} s is needed.",
        "Use a clip of at least a few minutes so queues and signal cycles show up.",
    )


def video_too_long(duration_s: float, limit_s: int) -> ApiError:
    return ApiError(
        "video_too_long",
        422,
        "The video is too long",
        f"The video is {duration_s / 60:.1f} minutes long. The limit is {limit_s / 60:.0f} minutes.",
        "Trim the clip, or analyse it in parts.",
        limitS=limit_s,
    )


def video_unreadable(detail: str = "The file could not be decoded.") -> ApiError:
    return ApiError(
        "video_unreadable",
        422,
        "The video could not be read",
        detail,
        "Check that the file is not damaged and plays in a video player. Re-export it as H.264 MP4 if it does.",
    )


def no_video_stream() -> ApiError:
    return ApiError(
        "no_video_stream",
        422,
        "The file has no video",
        "The file contains no video track. It may be audio only.",
        "Upload a file that contains the video of the junction.",
    )


def geometry_incomplete(missing: list[dict[str, str]]) -> ApiError:
    parts = ", ".join(f"{m['approach']} {m['shape']}" for m in missing[:6])
    return ApiError(
        "geometry_incomplete",
        422,
        "The junction drawing is incomplete",
        f"Missing: {parts}.",
        "Open Setup, step 2, and draw the missing stop lines and upstream lines for at least two approaches.",
        missing=missing,
    )


def calibration_invalid(detail: str) -> ApiError:
    return ApiError(
        "calibration_invalid",
        422,
        "The calibration points cannot be used",
        detail,
        "Open Setup, step 3, and mark four corners of a rectangle on the road, then enter the real distances in metres.",
    )


def junction_invalid(detail: str) -> ApiError:
    return ApiError(
        "junction_invalid",
        422,
        "The junction description is not valid",
        detail,
        "Save the junction again from Setup, or export a fresh junction file.",
    )


def model_unavailable(detail: str = "The detection model could not be loaded.") -> ApiError:
    return ApiError(
        "model_unavailable",
        503,
        "The detection model is not available",
        detail,
        "The server is missing its model file. Tell whoever runs the server, then try again.",
    )


def queue_full(retry_after_s: int) -> ApiError:
    return ApiError(
        "queue_full",
        429,
        "The analysis queue is full",
        "Other videos are being analysed and the waiting list is full.",
        f"Try again in about {retry_after_s} s.",
        retryAfterS=retry_after_s,
    )


def rate_limited(retry_after_s: int) -> ApiError:
    return ApiError(
        "queue_full",
        429,
        "Too many requests",
        "This address has made too many requests in a short time.",
        f"Wait about {retry_after_s} s and try again.",
        retryAfterS=retry_after_s,
    )


def job_not_found(job_id: str) -> ApiError:
    return ApiError(
        "job_not_found",
        404,
        "That analysis does not exist",
        f"No analysis with id {job_id} was found. It may have been deleted after the retention period.",
        "Start the analysis again.",
    )


def video_not_found(video_id: str) -> ApiError:
    return ApiError(
        "job_not_found",
        404,
        "That video does not exist",
        f"No video with id {video_id} was found. It may have been deleted after the retention period.",
        "Upload the video again.",
    )


def job_cancelled() -> ApiError:
    return ApiError(
        "job_cancelled",
        409,
        "The analysis was cancelled",
        "The analysis was stopped before it finished, so there is no result.",
        "Start the analysis again if you still need it.",
    )


def job_not_ready(state: str) -> ApiError:
    return ApiError(
        "job_not_ready",
        409,
        "The analysis is not finished",
        f"The analysis is still {state}.",
        "Wait for it to finish, then ask for the result again.",
    )


def job_failed(correlation_id: str, detail: str = "The analysis stopped because of an internal problem.") -> ApiError:
    return ApiError(
        "job_failed",
        500,
        "The analysis failed",
        detail,
        f"Try again. If it keeps failing, report reference {correlation_id}.",
        correlationId=correlation_id,
    )


def timeout_error(limit_s: int) -> ApiError:
    return ApiError(
        "timeout",
        504,
        "The analysis took too long",
        f"It did not finish within {limit_s / 60:.0f} minutes and was stopped.",
        "Analyse a shorter clip, or lower the resolution.",
    )


def out_of_memory() -> ApiError:
    return ApiError(
        "out_of_memory",
        507,
        "The server ran out of memory",
        "The video needed more memory than the server allows.",
        "Export the clip at a lower resolution, or analyse it in shorter parts.",
    )


def disk_full() -> ApiError:
    return ApiError(
        "internal_error",
        507,
        "The server has no space left",
        "The server could not store the file because its disk is full.",
        "Try again later, or delete videos you no longer need.",
    )


def internal_error(correlation_id: str) -> ApiError:
    return ApiError(
        "internal_error",
        500,
        "Something went wrong on the server",
        "The request could not be completed because of an internal problem.",
        f"Try again. If it keeps happening, report reference {correlation_id}.",
        correlationId=correlation_id,
    )


def invalid_request(detail: str, fix: str = "Check the value and try again.") -> ApiError:
    return ApiError("invalid_request", 422, "The request is not valid", detail, fix)


def body_too_large(limit_kb: int) -> ApiError:
    return ApiError(
        "request_too_large",
        413,
        "The request is too large",
        f"The request body is over {limit_kb} KB.",
        "Send less data. Videos are uploaded separately, not inside this request.",
    )


def experiment_too_large(runs: int, horizon: int, limit: int) -> ApiError:
    return ApiError(
        "experiment_too_large",
        422,
        "That experiment is too big",
        f"It would simulate {runs:,} runs of {horizon:,} s, which is {runs * horizon:,} simulated seconds. The limit is {limit:,}.",
        "Use fewer seeds, fewer controllers or a shorter horizon.",
    )


def simulation_too_long(horizon: int, limit: int) -> ApiError:
    return ApiError(
        "simulation_too_long",
        422,
        "That simulation is too long for one call",
        f"The horizon is {horizon:,} s. A single call allows up to {limit:,} s.",
        "Lower the horizon on the Parameters page, or run it as an experiment.",
    )


def unauthorized() -> ApiError:
    return ApiError(
        "unauthorized",
        401,
        "A key is needed",
        "This server requires an API key and the request did not include a valid one.",
        "Add the X-API-Key header, or ask whoever runs the server for the key.",
    )


# ----- FastAPI wiring ------------------------------------------------------------------------


def correlation_id_of(request: Request) -> str | None:
    cid = getattr(request.state, "correlation_id", None)
    return cid if isinstance(cid, str) else None


def problem_response(err: ApiError, cid: str | None, headers: dict[str, str] | None = None) -> JSONResponse:
    h = dict(headers or {})
    retry = err.extra.get("retryAfterS")
    if retry is not None:
        h["Retry-After"] = str(retry)
    return JSONResponse(err.problem(cid), status_code=err.status, media_type=PROBLEM_JSON, headers=h)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return problem_response(exc, correlation_id_of(request))

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(x) for x in first.get("loc", []) if x != "body") or "request"
        msg = str(first.get("msg", "invalid value"))
        err = ApiError(
            "junction_invalid" if "junction" in loc else "invalid_request",
            422,
            "The request is not valid",
            f"{loc}: {msg}.",
            "Check the value and try again. If it came from a saved junction, save the junction again in Setup.",
        )
        return problem_response(err, correlation_id_of(request))

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        status = exc.status_code
        if status == 404:
            err = ApiError("not_found", 404, "That address does not exist", "No such endpoint.", "Check the address.")
        elif status == 405:
            err = ApiError("method_not_allowed", 405, "That action is not allowed here", "Wrong HTTP method.", "Check the documentation at /docs.")
        elif status == 413:
            err = ApiError("video_too_large", 413, "The request is too large", "The request body is over the allowed size.", "Send a smaller request.")
        else:
            err = ApiError("request_error", status, "The request could not be handled", str(exc.detail), "Check the request and try again.")
        return problem_response(err, correlation_id_of(request))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        cid = correlation_id_of(request) or "unknown"
        log.exception("unhandled error", extra={"correlation_id": cid, "path": request.url.path})
        return problem_response(internal_error(cid), cid)
