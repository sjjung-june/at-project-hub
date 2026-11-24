"""Pure Python plan/report rules; no browser or Node.js runtime dependency.

Stored Step goals/actuals are 0..100 completion ratios. The UI displays each
ratio * weight / 100 as a contribution capped by that Step's weight.
"""
from copy import deepcopy
from datetime import date
from decimal import Decimal, InvalidOperation
from .. import clock
from ..errors import DomainError

MODE = "cumulative-percent-v1"
WEIGHTED = "weighted-steps-v1"


def now_month():
    return clock.seoul_month()


def percent(value):
    if value is None or isinstance(value, bool) or str(value).strip() == "":
        return None
    try:
        number = Decimal(str(value))
        return float(number) if number.is_finite() and 0 <= number <= 100 else None
    except (InvalidOperation, ValueError):
        return None


def has_value(value):
    return value is not None and str(value).strip() != ""


def period(start, end):
    try:
        if len(start) != 10 or len(end) != 10:
            return []
        first, last = date.fromisoformat(start), date.fromisoformat(end)
    except (ValueError, TypeError):
        return []
    if first > last:
        return []
    a, b = first.year * 12 + first.month - 1, last.year * 12 + last.month - 1
    return [f"{i // 12:04d}-{i % 12 + 1:02d}" for i in range(a, b + 1)]


def weighted(project):
    return project.get("stepPlanMode") == WEIGHTED


def validate_goals(records, months, label):
    previous = None
    for month in months:
        goal = percent(records.get(month, {}).get("goal"))
        if goal is None:
            raise DomainError(f"{label} {month} 누적 목표를 0~100 완료 비율로 입력해 주세요.")
        if previous is not None and goal < previous:
            raise DomainError(f"{label} {month} 누적 목표는 이전 월 이상이어야 합니다.")
        previous = goal
    if previous != 100:
        raise DomainError(f"{label} 종료 월 목표는 Step 완료 비율 100이어야 합니다.")


def validate_plan(project):
    if not project.get("title", "").strip() or not project.get("team", "").strip() or not project.get("tech"):
        raise DomainError("제목·소속 팀·대상 Tech를 입력해 주세요.")
    months = period(project.get("startDate"), project.get("endDate"))
    if not months:
        raise DomainError("과제 시작일과 종료일을 확인해 주세요.")
    if project.get("planMode") != MODE:
        raise DomainError("누적 진척률 계획이 필요합니다.")
    if not weighted(project):
        validate_goals(project.get("monthly", {}), months, "과제")
        return
    steps = project.get("steps", [])
    if not steps:
        raise DomainError("Step을 한 개 이상 등록해 주세요.")
    ids, total = set(), Decimal(0)
    for step in steps:
        if not step.get("id") or step["id"] in ids:
            raise DomainError("Step 식별자가 없거나 중복됩니다.")
        ids.add(step["id"])
        if not step.get("name", "").strip():
            raise DomainError("Step 이름을 입력해 주세요.")
        weight = percent(step.get("weight"))
        if weight is None or weight <= 0:
            raise DomainError("Step 비중은 0 초과 100 이하로 입력해 주세요.")
        total += Decimal(str(step["weight"]))
        active = period(step.get("startDate"), step.get("endDate"))
        if not active or step["startDate"] < project["startDate"] or step["endDate"] > project["endDate"]:
            raise DomainError("Step 기간은 과제 추진 일정 안에 있어야 합니다.")
        validate_goals(step.get("monthly", {}), active, step["name"])
    if abs(total - Decimal(100)) > Decimal("0.000000001"):
        raise DomainError("Step 비중 합계는 100%여야 합니다.")


def step_goal(step, month):
    if month < step["startDate"][:7]:
        return 0
    if month > step["endDate"][:7]:
        return 100
    return percent(step.get("monthly", {}).get(month, {}).get("goal"))


def step_actual(step, month, reports):
    if month < step["startDate"][:7]:
        return 0
    rows = reports.get(step["id"], {})
    value = rows.get(month, {}).get("actual")
    if has_value(value):
        return percent(value)
    return 100 if any(step["startDate"][:7] <= m < month and percent(row.get("actual")) == 100 for m, row in rows.items()) else None


def totals(project, reports=None):
    result = deepcopy(project)
    if not weighted(project):
        return result
    reports = deepcopy(project.get("stepReports", {}) if reports is None else reports)
    monthly = {}
    steps = project.get("steps", [])
    for month in period(project.get("startDate"), project.get("endDate")):
        goals = [step_goal(step, month) for step in steps]
        actuals = [step_actual(step, month, reports) for step in steps]
        row = {}
        for key, values in [("goal", goals), ("actual", actuals)]:
            started = key == "goal" or any(month >= s["startDate"][:7] for s in steps)
            if started and all(v is not None for v in values):
                row[key] = round(sum(float(s["weight"]) * v / 100 for s, v in zip(steps, values)), 6)
        delayed = [s for s, g, a in zip(steps, goals, actuals) if a is not None and g is not None and a < g]
        for field in ("reason", "catchup"):
            text = " / ".join(f"{s['name']}: {reports[s['id']][month][field]}" for s in delayed if reports.get(s["id"], {}).get(month, {}).get(field))
            if text:
                row[field] = text
        monthly[month] = row
    result.update(monthly=monthly, stepReports=reports)
    return result


def validate_reports(project, as_of=None, require_explanations=True):
    cutoff = as_of or now_month()
    months = period(project["startDate"], project["endDate"])
    if weighted(project):
        groups = [(s["name"], [m for m in months if m >= s["startDate"][:7]], project.get("stepReports", {}).get(s["id"], {}), s) for s in project["steps"]]
    else:
        groups = [("과제", months, project.get("monthly", {}), None)]
    for name, active, rows, step in groups:
        previous = None
        for month in active:
            row = rows.get(month, {})
            if has_value(row.get("actual")):
                if month > cutoff:
                    raise DomainError(f"{month} 미래 실적은 입력할 수 없습니다.")
                if percent(row["actual"]) is None:
                    raise DomainError(f"{name} 누적 실적은 0~100 완료 비율이어야 합니다.")
            actual = step_actual(step, month, project.get("stepReports", {})) if step else percent(row.get("actual"))
            if actual is None:
                continue
            if previous is not None and actual < previous:
                raise DomainError(f"{name} {month} 누적 실적은 이전 값 이상이어야 합니다. 당월 증가분을 입력하지 않았는지, 보고 월을 잘못 선택하지 않았는지 확인해 주세요.")
            previous = actual
            goal = step_goal(step, month) if step else percent(row.get("goal"))
            if require_explanations and month <= cutoff and goal is not None and actual < goal and project.get('_reporting',{}).get(month,{}).get('status') not in ('submitted','approved'):
                if not str(row.get("reason", "")).strip() or not str(row.get("catchup", "")).strip():
                    raise DomainError(f"{name} {month} 지연 사유와 Catch Up Plan을 입력해 주세요.")


def summary(project, as_of=None):
    project = totals(project)
    months = [m for m in period(project["startDate"], project["endDate"]) if m <= (as_of or now_month())]
    missing = [m for m in months if percent(project.get("monthly", {}).get(m, {}).get("actual")) is None]
    known = [m for m in months if m not in missing]
    latest = project["monthly"][known[-1]] if known else {}
    actual, goal = percent(latest.get("actual")), percent(latest.get("goal"))
    late = actual is not None and goal is not None and actual < goal
    return {"label": "시작 전" if not months else "지연" if late else "실적 미입력" if missing else "정상", "late": late, "missingMonths": missing, "goal": goal, "actual": actual}
