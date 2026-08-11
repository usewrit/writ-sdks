"""File assets: a run's bindable INPUTS (``file_slots``) and its captured
OUTPUTS (``output_files``).

Both are pure derivations — no daemon needed. The slot rule is shared with the
coordinator, the run form and the replay engine, so these cases mirror the ones
asserted there.
"""

from __future__ import annotations

import pytest

from writ_agent import file_slots, output_files

WORKFLOW = {
    "steps": [
        {"id": "s1", "type": "upload", "config": {"file_slot": "resume", "label": "Your CV"}},
        {"id": "s2", "type": "upload", "config": {"file_id": "file_pinned", "file_name": "invoice.pdf"}},
        {"id": "s3", "type": "upload", "options": {"file_id": "file_rec", "filename": "scan.png"}},
        {"id": "s4", "type": "click", "config": {"selector": ".go"}},
    ]
}


def test_every_upload_step_is_a_file_input() -> None:
    assert [s["slot"] for s in file_slots(WORKFLOW)] == ["resume", "step:s2", "step:s3"]


def test_declared_slot_without_a_pinned_file_must_be_bound() -> None:
    resume = file_slots(WORKFLOW)[0]
    assert resume["declared"] is True
    assert resume["default_file_id"] is None
    assert resume["label"] == "Your CV"


def test_pinned_step_carries_its_file_as_the_default() -> None:
    pinned = file_slots(WORKFLOW)[1]
    assert pinned["declared"] is False
    assert pinned["default_file_id"] == "file_pinned"
    assert pinned["default_filename"] == "invoice.pdf"


def test_recorder_options_shape_is_read_too() -> None:
    # The recorder writes options.file_id/filename; the editor writes config.*.
    recorded = file_slots(WORKFLOW)[2]
    assert recorded["default_file_id"] == "file_rec"
    assert recorded["default_filename"] == "scan.png"


def test_config_wins_over_options() -> None:
    wf = {"steps": [{"id": "s1", "type": "upload",
                     "config": {"file_id": "edited"}, "options": {"file_id": "recorded"}}]}
    assert file_slots(wf)[0]["default_file_id"] == "edited"


def test_dedupes_by_slot_order_preserving() -> None:
    wf = {"steps": [
        {"id": "a", "type": "upload", "config": {"file_slot": "cv"}},
        {"id": "b", "type": "upload", "config": {"file_slot": "cv"}},
    ]}
    assert [s["slot"] for s in file_slots(wf)] == ["cv"]


@pytest.mark.parametrize(
    "workflow",
    [
        {"steps": [{"id": "x", "type": "click"}]},
        {"steps": []},
        {},
        {"steps": "not-a-list"},
        {"steps": [None, 7, "x"]},
        None,
    ],
)
def test_no_uploads_yields_empty_and_never_raises(workflow: object) -> None:
    assert file_slots(workflow) == []


CAPTURED = {
    "file_id": "file_dl",
    "filename": "report.csv",
    "size": 12,
    "content_type": "text/csv",
    "output_key": "report",
}


@pytest.mark.parametrize(
    "payload",
    [
        {"result_data": {"output_files": [CAPTURED]}},
        {"output_files": [CAPTURED]},
        {"results": {"output_files": [CAPTURED]}},
    ],
)
def test_output_files_reads_every_envelope(payload: dict) -> None:
    assert output_files(payload) == [CAPTURED]


@pytest.mark.parametrize(
    "payload", [{"result_data": {}}, {}, None, "nope", {"result_data": "junk"}]
)
def test_output_files_empty_when_nothing_captured(payload: object) -> None:
    assert output_files(payload) == []
