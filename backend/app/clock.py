"""Single clock boundary. Tests replace utc_now; no runtime time-travel endpoint."""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def utc_now():
    return datetime.now(timezone.utc)


def seoul_month():
    return utc_now().astimezone(ZoneInfo('Asia/Seoul')).strftime('%Y-%m')


def timestamp():
    return utc_now().isoformat().replace('+00:00', 'Z')
