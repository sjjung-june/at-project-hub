from copy import deepcopy
import pytest
from app.domain import plans, approvals
from app.errors import DomainError
from app.schemas import ProjectPlan, ReportUpdate


def test_weighted_goals_and_missing_are_immutable(project):
    before = deepcopy(project)
    plans.validate_plan(project)
    result = plans.totals(project)
    assert result["monthly"]["2025-01"]["goal"] == 70
    assert "actual" not in result["monthly"]["2025-01"]
    assert project == before


@pytest.mark.parametrize("weight", [59, 61, 59.999999, 0, -1, 101])
def test_weight_total_and_range(project, weight):
    project["steps"][1]["weight"] = weight
    with pytest.raises(DomainError):
        plans.validate_plan(project)


def test_duplicate_id_and_bad_period(project):
    project["steps"][1]["id"] = "a"
    with pytest.raises(DomainError, match="중복"):
        plans.validate_plan(project)
    project["steps"][1]["id"] = "b"
    project["steps"][0]["startDate"] = "2024-12-31"
    with pytest.raises(DomainError, match="기간"):
        plans.validate_plan(project)


def test_cumulative_goals_final_and_dates(project):
    project["steps"][1]["monthly"]["2025-02"]["goal"] = 40
    with pytest.raises(DomainError, match="이전"):
        plans.validate_plan(project)
    project["steps"][1]["monthly"]["2025-02"]["goal"] = 90
    with pytest.raises(DomainError, match="종료"):
        plans.validate_plan(project)
    assert plans.period("2025-02-30", "2025-03-01") == []
    assert plans.period("2026-12-01", "2027-02-28") == ["2026-12", "2027-01", "2027-02"]


def test_missing_zero_completed_carry_and_recovery(project):
    project["stepReports"] = {"a": {"2025-01": {"actual": 80}}, "b": {"2025-01": {"actual": 50}, "2025-02": {"actual": 100}}}
    result = plans.totals(project)
    assert result["monthly"]["2025-01"]["actual"] == 62
    assert "actual" not in result["monthly"]["2025-02"]
    project["stepReports"]["a"]["2025-02"] = {"actual": 90}
    assert plans.summary(project)["actual"] == 96
    assert plans.summary(project)["late"]
    with pytest.raises(DomainError, match="지연 사유"):
        plans.validate_reports(project)
    project["stepReports"]["a"]["2025-01"] = {"actual": 100}
    assert plans.summary(project)["late"]
    project["stepReports"]["a"].pop("2025-02")
    assert plans.summary(project)["actual"] == 100
    assert not plans.summary(project)["late"]
    project["stepReports"]["b"]["2025-01"] = {"actual": 0, "reason": "사유", "catchup": "계획"}
    assert plans.totals(project)["monthly"]["2025-01"]["actual"] == 40


def test_future_and_decreasing_actuals(project):
    project["stepReports"] = {"a": {"2025-01": {"actual": 100}, "2025-02": {"actual": 80}}}
    with pytest.raises(DomainError, match="이전"):
        plans.validate_reports(project)
    with pytest.raises(DomainError, match="미래"):
        plans.validate_reports(project, as_of="2024-12")


def test_snapshot_ignores_reports_and_approval_preserves_latest(project, actor):
    candidate = deepcopy(project)
    candidate["steps"][0]["weight"] = 50
    candidate["steps"][1]["weight"] = 50
    candidate["stepReports"] = {"a": {"2025-01": {"actual": 1}}}
    requested = approvals.create_request(project, candidate, "비중 조정", actor.model_dump())
    assert requested["steps"][0]["weight"] == 40
    request = requested["_changeRequests"][0]
    assert "stepReports" not in request["candidate"]
    requested["stepReports"] = {"a": {"2025-01": {"actual": 100}}, "b": {"2025-01": {"actual": 60}}}
    lead = {"id": "lead", "name": "팀장", "role": "team-lead", "team": "AT팀"}
    approved = approvals.decide(requested, request["id"], "approved", "검토 완료", lead)
    assert approved["steps"][0]["weight"] == 50
    assert approved["stepReports"]["b"]["2025-01"]["actual"] == 60
    assert approved["monthly"]["2025-01"]["actual"] == 80


@pytest.mark.parametrize("role,team", [("member", "AT팀"), ("system-admin", "AT팀"), ("team-lead", "다른 팀")])
def test_invalid_reviewer(project, actor, role, team):
    candidate = deepcopy(project)
    candidate["title"] = "제목 변경"
    requested = approvals.create_request(project, candidate, "사유", actor.model_dump())
    with pytest.raises(DomainError) as error:
        approvals.decide(requested, requested["_changeRequests"][0]["id"], "approved", "확인", {"id": "other", "name": "검토자", "role": role, "team": team})
    assert error.value.status == 403


def test_self_review_pending_stale_and_head_only(project, actor):
    candidate = deepcopy(project)
    candidate["title"] = "제목 변경"
    requested = approvals.create_request(project, candidate, "사유", actor.model_dump())
    rid = requested["_changeRequests"][0]["id"]
    with pytest.raises(DomainError, match="본인"):
        approvals.decide(requested, rid, "approved", "확인", {**actor.model_dump(), "role": "at-head"})
    with pytest.raises(DomainError, match="검토 중"):
        approvals.create_request(requested, candidate, "추가", actor.model_dump())
    requested["title"] = "동시 수정"
    with pytest.raises(DomainError, match="요청 후"):
        approvals.decide(requested, rid, "approved", "확인", {"id": "lead", "name": "팀장", "role": "team-lead", "team": "AT팀"})
    candidate = deepcopy(project)
    candidate["po"] = "새 대표"
    assert approvals.required_role(project, candidate) == "at-head"


def test_withdrawal_and_comment_required(project, actor):
    candidate = {**deepcopy(project), "title": "변경"}
    requested = approvals.create_request(project, candidate, "사유", actor.model_dump())
    rid = requested["_changeRequests"][0]["id"]
    with pytest.raises(DomainError):
        approvals.decide(requested, rid, "withdrawn", "", actor.model_dump())
    result = approvals.decide(requested, rid, "withdrawn", "재검토", actor.model_dump())
    assert result["title"] == project["title"]
    assert result["_changeRequests"][0]["status"] == "withdrawn"


def test_legacy_conversion_preserves_reports_and_archives_removed_steps(project, actor):
    old = deepcopy(project)
    for key in ("steps", "stepPlanMode", "stepReports"):
        old.pop(key)
    old["monthly"] = {"2025-01": {"goal": 70, "actual": 60}, "2025-02": {"goal": 100}}
    next_project = approvals.merge_candidate(old, project)
    assert next_project["legacyAggregateReports"]["monthly"]["2025-01"]["actual"] == 60
    assert "actual" not in next_project["monthly"]["2025-01"]
    project["stepReports"] = {"a": {"2025-01": {"actual": 100}}}
    candidate = deepcopy(project)
    candidate["steps"] = [candidate["steps"][1]]
    candidate["steps"][0]["weight"] = 100
    assert approvals.merge_candidate(project, candidate)["stepReports"]["a"]["2025-01"]["actual"] == 100


def test_pydantic_input_contract_filters_server_owned_fields(project):
    model = ProjectPlan.model_validate({**project, "_ownerId": "attacker", "_audit": ["forged"], "monthly": {"2025-01": {"goal": 70, "actual": 99}}})
    assert "_ownerId" not in model.model_dump()
    assert "actual" not in model.model_dump()["monthly"]["2025-01"]
    with pytest.raises(ValueError):
        ReportUpdate.model_validate({"stepReports": {"a": {"2025-01": {"actual": 101}}}})
