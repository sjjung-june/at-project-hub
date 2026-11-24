from copy import deepcopy
from datetime import datetime, timezone
from unicodedata import normalize
from uuid import uuid4
from .plans import percent, period, totals, validate_plan, validate_reports, weighted
from ..errors import DomainError

FIELDS = "id title team po pm members type tech special status background kpi plan startDate endDate startMonth endMonth unit planMode htrsSub aiSub".split()


def timestamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def snapshot(project):
    result = {field: sorted(project.get(field, [])) if field in ("tech", "special") else str(project.get(field) or "").strip() for field in FIELDS}
    if weighted(project):
        result["stepPlanMode"] = "weighted-steps-v1"
        result["steps"] = [{"id": s["id"], "name": s["name"].strip(), "weight": percent(s["weight"]), "completionCriteria": s.get("completionCriteria", ""), "evidenceRequired": s.get("evidenceRequired", False), "startDate": s["startDate"], "endDate": s["endDate"], "monthly": {m: {"goal": percent(r.get("goal"))} for m, r in sorted(s.get("monthly", {}).items())}} for s in project.get("steps", [])]
        project = totals(project)
    result["monthly"] = {m: {"goal": percent(r.get("goal"))} for m, r in sorted(project.get("monthly", {}).items())}
    result["archivedAt"] = project.get("archivedAt") or None
    return result


def changes(before, after):
    def flatten(value, prefix=""):
        if isinstance(value, dict):
            return {k: v for key, child in value.items() for k, v in flatten(child, f"{prefix}.{key}" if prefix else key).items()}
        return {prefix: value}
    a, b = flatten(snapshot(before)), flatten(snapshot(after))
    return [{"field": key, "label": key, "before": a.get(key), "after": b.get(key)} for key in sorted(a.keys() | b.keys()) if a.get(key) != b.get(key)]


def required_role(before, after):
    return "at-head" if any(c["field"] in ("team", "po", "startDate", "endDate", "startMonth", "endMonth", "archivedAt") for c in changes(before, after)) else "team-lead"


def same_person(a, b):
    name = lambda actor: " ".join(normalize("NFC", actor.get("name", "")).split()).casefold()
    return bool(a.get("id") and a["id"] == b.get("id") or name(a) and name(a) == name(b))


def merge_candidate(project, candidate):
    diff = changes(project, candidate)
    if diff and all(c["field"] == "archivedAt" for c in diff):
        return {**deepcopy(project), "archivedAt": candidate.get("archivedAt")}
    validate_plan(candidate)
    if weighted(project) and not weighted(candidate):
        raise DomainError("Step 계획을 단일 계획으로 되돌릴 수 없습니다.")
    next_project = {**deepcopy(project), **snapshot(candidate)}
    if weighted(candidate):
        if not weighted(project):
            next_project["legacyAggregateReports"] = deepcopy({key: project.get(key, {}) for key in ("monthly", "monthlyArchive", "startDate", "endDate")})
        next_project = totals(next_project, project.get("stepReports", {}))
    else:
        archive = deepcopy(project.get("monthlyArchive", {}))
        current = project.get("monthly", {})
        active = period(candidate["startDate"], candidate["endDate"])
        next_project["monthly"] = {m: {**archive.pop(m, {}), **deepcopy(current.get(m, {})), "goal": candidate["monthly"][m]["goal"]} for m in active}
        archive.update({m: deepcopy(row) for m, row in current.items() if m not in active})
        next_project["monthlyArchive"] = archive
    # A goal change may expose an old delay: keep reports, request explanations later.
    validate_reports(next_project, require_explanations=False)
    final = period(next_project["startDate"], next_project["endDate"])[-1]
    if candidate.get("status") == "완료" and percent(next_project["monthly"].get(final, {}).get("actual")) != 100:
        raise DomainError("완료 상태는 종료 월 누적 실적 100%가 필요합니다.")
    return next_project


def audit(action, request, actor, before, after, comment=""):
    return {"id": str(uuid4()), "at": timestamp(), "action": action, "actor": actor, "requestId": request["id"], "reason": request["reason"], "comment": comment, "changes": changes(before, after), "before": snapshot(before), "after": snapshot(after)}


def create_request(project, candidate, reason, actor):
    if not reason.strip():
        raise DomainError("변경 사유를 입력해 주세요.")
    if any(r["status"] == "pending" for r in project.get("_changeRequests", [])):
        raise DomainError("검토 중인 변경 요청이 있습니다.")
    candidate = snapshot({**project, **candidate, "id": project["id"]})
    merge_candidate(project, candidate)
    diff = changes(project, candidate)
    if not diff:
        raise DomainError("변경된 정보나 목표가 없습니다.")
    request = {"id": str(uuid4()), "status": "pending", "reason": reason.strip(), "requestedAt": timestamp(), "requester": actor, "requiredRole": required_role(project, candidate), "base": snapshot(project), "candidate": candidate, "changes": diff}
    result = deepcopy(project)
    result.setdefault("_baseline", snapshot(project))
    result.setdefault("_changeRequests", []).append(request)
    result.setdefault("_audit", []).append(audit("change_requested", request, actor, project, candidate))
    return result


def decide(project, request_id, decision, comment, actor):
    request = next((r for r in project.get("_changeRequests", []) if r["id"] == request_id), None)
    if not request:
        raise DomainError("변경 요청을 찾을 수 없습니다.", 404)
    if request["status"] != "pending":
        raise DomainError("이미 처리된 요청입니다.")
    if decision not in ("approved", "rejected", "withdrawn") or not comment.strip():
        raise DomainError("처리 방법과 검토 의견을 확인해 주세요.")
    if decision == "withdrawn":
        if not same_person(actor, request["requester"]):
            raise DomainError("요청자만 철회할 수 있습니다.", 403)
    else:
        if same_person(actor, request["requester"]):
            raise DomainError("본인이 요청한 변경을 직접 승인하거나 반려할 수 없습니다.", 403)
        role = required_role(request["base"], request["candidate"])
        if not (actor["role"] == "at-head" or role == "team-lead" and actor["role"] == "team-lead" and actor.get("team") == request["base"]["team"]):
            raise DomainError("변경안을 검토할 권한이 없습니다.", 403)
    if decision == "approved" and changes(request["base"], project):
        raise DomainError("요청 후 계획이 변경되었습니다. 다시 요청해 주세요.", 409)
    result = merge_candidate(project, request["candidate"]) if decision == "approved" else deepcopy(project)
    result["_changeRequests"] = [{**deepcopy(r), **({"status": decision, "decidedAt": timestamp(), "reviewer": actor, "comment": comment.strip()} if r["id"] == request_id else {})} for r in project["_changeRequests"]]
    result.setdefault("_audit", []).append(audit(f"change_{decision}", request, actor, project, result, comment.strip()))
    return result
