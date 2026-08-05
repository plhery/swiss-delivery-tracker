"""Small dependency-free validator for the schemas used in API contract tests."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID


CONTRACT_PATH = Path(__file__).resolve().parents[2] / "contracts" / "openapi.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def contract_schema(name: str) -> dict[str, object]:
    return CONTRACT["components"]["schemas"][name]


def assert_contract(name: str, value: object) -> None:
    _assert_schema(contract_schema(name), value, f"{name}")


def _assert_schema(schema: dict[str, object], value: object, path: str) -> None:
    reference = schema.get("$ref")
    if isinstance(reference, str):
        prefix = "#/components/schemas/"
        if not reference.startswith(prefix):
            raise AssertionError(f"{path}: unsupported reference {reference}")
        _assert_schema(contract_schema(reference.removeprefix(prefix)), value, path)
        return

    alternatives = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(alternatives, list):
        failures = []
        for alternative in alternatives:
            try:
                _assert_schema(alternative, value, path)
                return
            except AssertionError as exc:
                failures.append(str(exc))
        raise AssertionError(f"{path}: no contract alternative matched ({'; '.join(failures)})")

    declared_type = schema.get("type")
    if isinstance(declared_type, list):
        failures = []
        for option in declared_type:
            try:
                _assert_schema({**schema, "type": option}, value, path)
                return
            except AssertionError as exc:
                failures.append(str(exc))
        raise AssertionError(f"{path}: expected one of {declared_type} ({'; '.join(failures)})")

    if declared_type == "null":
        if value is not None:
            raise AssertionError(f"{path}: expected null")
        return
    if declared_type == "boolean":
        if not isinstance(value, bool):
            raise AssertionError(f"{path}: expected boolean")
    elif declared_type == "integer":
        if not isinstance(value, int) or isinstance(value, bool):
            raise AssertionError(f"{path}: expected integer")
    elif declared_type == "number":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise AssertionError(f"{path}: expected number")
    elif declared_type == "string":
        if not isinstance(value, str):
            raise AssertionError(f"{path}: expected string")
        if len(value) < int(schema.get("minLength", 0)):
            raise AssertionError(f"{path}: string is too short")
        if len(value) > int(schema.get("maxLength", len(value))):
            raise AssertionError(f"{path}: string is too long")
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and not re.search(pattern, value):
            raise AssertionError(f"{path}: string does not match {pattern}")
        _assert_format(schema.get("format"), value, path)
    elif declared_type == "array":
        if not isinstance(value, list):
            raise AssertionError(f"{path}: expected array")
        item_schema = schema.get("items", {})
        for index, item in enumerate(value):
            _assert_schema(item_schema, item, f"{path}[{index}]")
    elif declared_type == "object":
        if not isinstance(value, dict):
            raise AssertionError(f"{path}: expected object")
        properties = schema.get("properties", {})
        required = set(schema.get("required", []))
        missing = required.difference(value)
        if missing:
            raise AssertionError(f"{path}: missing required fields {sorted(missing)}")
        if schema.get("additionalProperties") is False:
            extra = set(value).difference(properties)
            if extra:
                raise AssertionError(f"{path}: unexpected fields {sorted(extra)}")
        for key, property_schema in properties.items():
            if key in value:
                _assert_schema(property_schema, value[key], f"{path}.{key}")

    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        raise AssertionError(f"{path}: {value!r} is outside {enum!r}")
    minimum = schema.get("minimum")
    if isinstance(minimum, (int, float)) and isinstance(value, (int, float)) and value < minimum:
        raise AssertionError(f"{path}: {value!r} is below {minimum!r}")


def _assert_format(format_name: object, value: str, path: str) -> None:
    try:
        if format_name == "uuid":
            UUID(value)
        elif format_name == "date-time":
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        elif format_name == "uri":
            parsed = urlparse(value)
            if not parsed.scheme or not parsed.netloc:
                raise ValueError
    except ValueError as exc:
        raise AssertionError(f"{path}: invalid {format_name}") from exc
