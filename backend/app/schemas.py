from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

Role = Literal["at-head", "team-lead", "system-admin", "project-representative", "participant", "member"]


class Actor(BaseModel):
    model_config = ConfigDict(frozen=True)
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    role: Role
    team: str = ""
    authenticated: bool = True


class GoalRow(BaseModel):
    goal: float = Field(ge=0, le=100, allow_inf_nan=False)


class StepPlan(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=120)
    weight: float = Field(gt=0, le=100, allow_inf_nan=False)
    completionCriteria: str = Field(default="", max_length=2000)
    evidenceRequired: bool = False
    startDate: str
    endDate: str
    monthly: dict[str, GoalRow]


class ProjectPlan(BaseModel):
    # Client metadata such as _ownerId/_audit is never accepted as authority.
    model_config = ConfigDict(extra="ignore")
    id: str | None = None
    title: str = Field(min_length=1, max_length=150)
    team: str = Field(min_length=1, max_length=300)
    po: str = ""
    pm: str = ""
    members: str = ""
    type: str = ""
    tech: list[str] = Field(min_length=1)
    special: list[str] = []
    background: str = ""
    kpi: str = ""
    plan: str = ""
    htrsSub: str = ""
    aiSub: str = ""
    status: Literal["계획", "진행", "완료", "보류"] = "계획"
    startDate: str
    endDate: str
    unit: Literal["%"] = "%"
    planMode: Literal["cumulative-percent-v1"] = "cumulative-percent-v1"
    stepPlanMode: Literal["weighted-steps-v1"] | None = None
    steps: list[StepPlan] = []
    monthly: dict[str, GoalRow] = {}
    archivedAt: str | None = None


class ReportRow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actual: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    reason: str = Field(default="", max_length=10000)
    catchup: str = Field(default="", max_length=10000)


class ReportUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stepReports: dict[str, dict[str, ReportRow]] | None = None
    monthly: dict[str, ReportRow] | None = None


class ChangeRequest(BaseModel):
    candidate: ProjectPlan
    reason: str = Field(min_length=1, max_length=10000)


class Decision(BaseModel):
    decision: Literal["approved", "rejected", "withdrawn"]
    comment: str = Field(min_length=1, max_length=10000)


class ProjectList(BaseModel):
    projects: list[dict[str, Any]]
    limit: int
    offset: int


class ReportReview(BaseModel):
    decision: Literal["approved", "returned"]
    comment: str = Field(min_length=1, max_length=10000)

    @field_validator('comment')
    @classmethod
    def nonblank(cls,value):
        if not value.strip():
            raise ValueError('검토 의견이 필요합니다.')
        return value
