from copy import deepcopy
import pytest
from app.schemas import Actor


@pytest.fixture
def actor():
    return Actor(id="owner", name="과제 대표", role="project-representative", team="AT팀")


@pytest.fixture
def project():
    return {"id": "project", "title": "검증 과제", "team": "AT팀", "tech": ["All Tech"], "status": "진행", "unit": "%", "planMode": "cumulative-percent-v1", "stepPlanMode": "weighted-steps-v1", "startDate": "2025-01-01", "endDate": "2025-02-28", "startMonth": "2025-01", "endMonth": "2025-02", "steps": [{"id": "a", "name": "설계", "weight": 40, "startDate": "2025-01-01", "endDate": "2025-01-31", "monthly": {"2025-01": {"goal": 100}}}, {"id": "b", "name": "검증", "weight": 60, "startDate": "2025-01-01", "endDate": "2025-02-28", "monthly": {"2025-01": {"goal": 50}, "2025-02": {"goal": 100}}}], "stepReports": {}, "monthly": {}}
