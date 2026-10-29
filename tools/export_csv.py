#!/usr/bin/env python3
"""Flatten a researcher's private Supabase export without network access.

Usage: python export_csv.py responses.csv -o responses_wide.csv
Only is_test=false rows are included unless --include-test is supplied.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any


METADATA = (
    "id",
    "study_id",
    "version",
    "condition_id",
    "started_at",
    "submitted_at",
    "server_duration_seconds",
    "is_test",
    "consent",
)
REQUIRED = (*METADATA, "answers")
TRUE_VALUES = {"true", "t", "1"}
FALSE_VALUES = {"false", "f", "0"}


class ExportError(ValueError):
    """An input cannot be converted without losing its meaning."""


def parse_boolean(value: Any, field: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in TRUE_VALUES:
            return True
        if normalized in FALSE_VALUES:
            return False
    raise ExportError(f"{field} must be true/false (or t/f, 1/0), not missing or ambiguous")


def load_records(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        if path.suffix.lower() == ".csv":
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                raise ExportError("CSV has no header")
            if len(reader.fieldnames) != len(set(reader.fieldnames)):
                raise ExportError("CSV has duplicate header names")
            records = list(reader)
            if any(None in record or None in record.values() for record in records):
                raise ExportError("CSV contains a row with an unexpected number of columns")
        elif path.suffix.lower() == ".json":
            records = json.load(handle)
            if isinstance(records, dict) and set(records) == {"data"}:
                records = records["data"]
        else:
            raise ExportError("Input must be a .csv or .json file encoded as UTF-8")
    if not isinstance(records, list) or any(not isinstance(row, dict) for row in records):
        raise ExportError('JSON must be an array of row objects, or {"data": [...]}')
    return records


def parse_answers(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise ExportError("answers must contain a valid JSON object") from error
    if not isinstance(value, dict):
        raise ExportError("answers must be a JSON object keyed by question ID")
    for key, answer in value.items():
        if not isinstance(key, str) or not key:
            raise ExportError("Every answer must have a nonempty question ID")
        if answer is not None and not isinstance(answer, (str, int, float, bool)):
            raise ExportError(f"Answer {key!r} must be a scalar, not a list or object")
        if isinstance(answer, float) and not math.isfinite(answer):
            raise ExportError(f"Answer {key!r} is not a finite number")
    return value


def question_columns(question_ids: set[str]) -> dict[str, str]:
    """Use ASCII SPSS names, at most 64 characters, unique ignoring case."""
    mapping: dict[str, str] = {}
    used = set(METADATA)
    for key in sorted(question_ids, key=lambda item: (item.casefold(), item)):
        base = "q_" + re.sub(r"[^A-Za-z0-9_]", "_", key)
        changed = not re.fullmatch(r"[A-Za-z0-9_]+", key) or len(base) > 64
        if changed or base.casefold() in used:
            digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
            # Extend the digest on an unlikely collision, keeping the SPSS limit.
            for size in range(8, 61, 4):
                candidate = base[: 63 - size] + "_" + digest[:size]
                if candidate.casefold() not in used:
                    base = candidate
                    break
            else:
                raise ExportError("Could not generate unique SPSS question column names")
        mapping[key] = base
        used.add(base.casefold())
    return mapping


def safe_cell(value: Any) -> str | int | float:
    """Keep numeric values numeric; neutralize formulas in untrusted strings."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    if not isinstance(value, str):
        raise ExportError("Unexpected non-scalar cell")
    if value.startswith(("\t", "\r", "\n")) or value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def normalize_record(record: dict[str, Any]) -> dict[str, Any]:
    missing = [field for field in REQUIRED if field not in record]
    if missing:
        raise ExportError("Missing exported columns: " + ", ".join(missing))
    output: dict[str, Any] = {}
    for field in METADATA:
        value = record[field]
        if field in {"is_test", "consent"}:
            value = parse_boolean(value, field)
        elif field == "server_duration_seconds":
            if isinstance(value, bool) or not re.fullmatch(r"[0-9]+", str(value)):
                raise ExportError("server_duration_seconds must be a nonnegative integer")
            value = int(value)
        elif not isinstance(value, str) or not value.strip():
            raise ExportError(f"{field} must be a nonempty string")
        output[field] = value
    output["answers"] = parse_answers(record["answers"])
    return output


def export_records(
    records: list[dict[str, Any]], output_path: Path, *, include_test: bool = False
) -> dict[str, Any]:
    """Validate everything first, then write a BOM CSV and question-ID sidecar."""
    rows = []
    excluded = 0
    for number, record in enumerate(records, start=1):
        try:
            is_test = parse_boolean(record.get("is_test"), "is_test")
            if is_test and not include_test:
                excluded += 1
                continue
            rows.append(normalize_record(record))
        except ExportError as error:
            raise ExportError(f"Row {number}: {error}") from error
    mapping = question_columns({key for row in rows for key in row["answers"]})
    columns = [*METADATA, *mapping.values()]
    codebook = {
        "format": "vignette_responses_wide_v1",
        "exported_rows": len(rows),
        "excluded_test_rows": excluded,
        "include_test": include_test,
        "metadata_columns": list(METADATA),
        "question_columns": mapping,
        "boolean_coding": {"false": 0, "true": 1},
        "missing_coding": "empty cell; numeric zero is preserved",
        "formula_protection": "Risky string cells have a leading apostrophe; numeric cells do not.",
        "notes": [
            "No reverse scoring, scale averaging, type classification or numeric recoding is applied.",
            "String enum values remain labels; actual integer enum values remain integers.",
            "Question IDs are mapped to ASCII SPSS names of at most 64 characters.",
            "Different studies, versions and conditions remain distinct in metadata columns.",
            "session_id and answer_hash are intentionally excluded.",
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\r\n")
        writer.writeheader()
        for row in rows:
            flattened = {field: safe_cell(row[field]) for field in METADATA}
            flattened.update({column: safe_cell(row["answers"].get(key)) for key, column in mapping.items()})
            writer.writerow(flattened)
    codebook_path = output_path.with_name(output_path.stem + "_columns.json")
    codebook_path.write_text(json.dumps(codebook, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return codebook


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Private Supabase vignette_responses export (.csv/.json)")
    parser.add_argument("-o", "--output", required=True, type=Path, help="Output wide CSV; UTF-8 with BOM")
    parser.add_argument("--include-test", action="store_true", help="Include is_test=true rows explicitly")
    args = parser.parse_args(argv)
    sidecar = args.output.with_name(args.output.stem + "_columns.json")
    if args.output.suffix.lower() != ".csv":
        parser.error("Output must use a .csv extension")
    if args.input.resolve() in {args.output.resolve(), sidecar.resolve()}:
        parser.error("Output cannot overwrite the input file")
    try:
        result = export_records(load_records(args.input), args.output, include_test=args.include_test)
    except (OSError, UnicodeError, ValueError, csv.Error) as error:
        print(f"Export failed: {error}", file=sys.stderr)
        return 1
    print(
        f"Exported {result['exported_rows']} rows; excluded {result['excluded_test_rows']} test rows. "
        f"CSV: {args.output}; column map: {sidecar}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
