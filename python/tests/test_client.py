"""Sync client wire behavior (DESIGN §9.2/3/4/6/7): headers, envelope
normalization, error mapping, 202 run, cancel-as-result, CSV, bytes, multipart."""

from __future__ import annotations

import json

import httpx
import pytest

from writ_agent import (
    Page,
    WritAgent,
    WritApiError,
    WritConnectionError,
    run_row_id,
)

from .helpers import BASE_URL, TOKEN, json_response, make_client


def test_auth_and_user_agent_headers_on_the_wire():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        seen["ua"] = request.headers.get("User-Agent")
        return json_response(200, {"status": "ok"})

    with make_client(handler) as client:
        client.agent.status()
    assert seen["auth"] == f"Bearer {TOKEN}"
    assert seen["ua"] == "writ-sdk-python/0.1.0"


def test_trailing_slash_base_url_is_stripped():
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == f"{BASE_URL}/v1/agent"
        return json_response(200, {"status": "ok"})

    client = WritAgent(BASE_URL + "/", TOKEN, transport=httpx.MockTransport(handler))
    assert client.base_url == BASE_URL
    client.agent.status()
    client.close()


# ---------------------------------------------------------------------------
# Envelope normalization → Page (§6)
# ---------------------------------------------------------------------------

def test_data_count_envelope_normalizes_to_page():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/workflows"
        return json_response(
            200, {"data": [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}], "count": 2}
        )

    with make_client(handler) as client:
        page = client.workflows.list()
    assert isinstance(page, Page)
    assert page.count == 2
    assert page.total is None
    assert len(page) == 2
    assert [wf["id"] for wf in page] == [1, 2]
    assert page[0]["name"] == "a"


def test_data_count_total_envelope_normalizes_to_page():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/runs"
        assert request.url.params["limit"] == "1"
        return json_response(
            200,
            {"data": [{"id": "workflow-9", "status": "success"}], "count": 1, "total": 40},
        )

    with make_client(handler) as client:
        page = client.runs.list(limit=1)
    assert page.count == 1
    assert page.total == 40
    assert run_row_id(page[0]) == 9


def test_bare_array_envelope_normalizes_to_page():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/monitors"
        return json_response(200, [{"id": 5, "url": "https://x"}])

    with make_client(handler) as client:
        page = client.monitors.list()
    assert page.count == 1
    assert page.total is None
    assert page[0]["url"] == "https://x"


def test_bool_params_serialize_lowercase_and_none_dropped():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["active_only"] == "false"
        assert "limit" not in request.url.params
        return json_response(200, {"data": [], "count": 0})

    with make_client(handler) as client:
        client.workflows.list(active_only=False, limit=None)


# ---------------------------------------------------------------------------
# run / cancel (§7)
# ---------------------------------------------------------------------------

def test_run_returns_202_shape_and_posts_body():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/workflows/3/run"
        body = json.loads(request.content)
        assert body == {"inputs": {"city": "Paris"}, "persona_id": 7}
        return json_response(202, {"run_id": 11, "status": "running"})

    with make_client(handler) as client:
        started = client.workflows.run(3, inputs={"city": "Paris"}, persona_id=7)
    assert started == {"run_id": 11, "status": "running"}


def test_run_dry_run_returns_200_report():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["dry_run"] is True
        return json_response(200, {"dry_run": True, "workflow_id": 3, "step_count": 0})

    with make_client(handler) as client:
        report = client.workflows.run(3, dry_run=True)
    assert report["dry_run"] is True


def test_runs_cancel_202_and_409_both_return_results():
    def handler(request: httpx.Request) -> httpx.Response:
        run_id = request.url.path.split("/")[3]
        if run_id == "5":
            return json_response(202, {"run_id": 5, "status": "cancel_requested"})
        return json_response(
            409, {"run_id": 6, "status": "not_running", "run_status": "success"}
        )

    with make_client(handler) as client:
        assert client.runs.cancel(5)["status"] == "cancel_requested"
        stopped = client.runs.cancel(6)
        assert stopped["status"] == "not_running"
        assert stopped["run_status"] == "success"


def test_workflows_cancel_409_returns_result():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/workflows/3/cancel"
        return json_response(409, {"id": 3, "status": "not_running"})

    with make_client(handler) as client:
        assert client.workflows.cancel(3)["status"] == "not_running"


# ---------------------------------------------------------------------------
# CSV / bytes / multipart lanes (§9.6/7)
# ---------------------------------------------------------------------------

def test_data_csv_returns_raw_text():
    csv = "run_id,title\n5,A\n5,B\n"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/runs/5/data"
        assert request.url.params["format"] == "csv"
        return httpx.Response(
            200, headers={"Content-Type": "text/csv; charset=utf-8"}, content=csv.encode()
        )

    with make_client(handler) as client:
        assert client.runs.data_csv(5) == csv


def test_files_content_returns_bytes():
    blob = b"\x00\x01binary\xff"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/files/file_abc/content"
        return httpx.Response(
            200, headers={"Content-Type": "application/octet-stream"}, content=blob
        )

    with make_client(handler) as client:
        content = client.files.content("file_abc")
    assert isinstance(content, bytes)
    assert content == blob


def test_data_export_returns_text():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/workflows/3/data/export"
        assert request.url.params["format"] == "json"
        return httpx.Response(200, content=b'{"rows": []}')

    with make_client(handler) as client:
        assert client.data.export(3, format="json") == '{"rows": []}'


def test_multipart_upload_sends_well_formed_body():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["content_type"] = request.headers["Content-Type"]
        captured["body"] = request.read()
        return json_response(
            200,
            {
                "id": "file_1",
                "object": "file",
                "filename": "report.pdf",
                "bytes": 9,
                "source": "api",
            },
        )

    with make_client(handler) as client:
        handle = client.files.upload(
            b"%PDF-1.4\n", filename="report.pdf", content_type="application/pdf", source="api"
        )
    assert handle["id"] == "file_1"
    content_type = captured["content_type"]
    assert content_type.startswith("multipart/form-data; boundary=")
    boundary = content_type.split("boundary=", 1)[1].encode()
    body = captured["body"]
    assert boundary in body
    assert b'name="file"; filename="report.pdf"' in body
    assert b"Content-Type: application/pdf" in body
    assert b"%PDF-1.4\n" in body
    # The optional source text part rides along.
    assert b'name="source"' in body
    assert b"api" in body


def test_upload_from_path_defaults_filename(tmp_path):
    path = tmp_path / "notes.txt"
    path.write_bytes(b"hello")

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        assert b'filename="notes.txt"' in body
        assert b"hello" in body
        return json_response(200, {"id": "file_2", "filename": "notes.txt"})

    with make_client(handler) as client:
        assert client.files.upload(path)["id"] == "file_2"


# ---------------------------------------------------------------------------
# Error mapping (§5 / §9.4)
# ---------------------------------------------------------------------------

def test_json_error_body_maps_fields():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response(404, {"error": "not found: workflow 999999", "code": "not_found"})

    with make_client(handler) as client:
        with pytest.raises(WritApiError) as excinfo:
            client.workflows.get(999999)
    err = excinfo.value
    assert err.status == 404
    assert err.code == "not_found"
    assert err.message == "not found: workflow 999999"
    assert err.body == {"error": "not found: workflow 999999", "code": "not_found"}
    assert "not_found" in str(err)


def test_json_error_message_resolution_order():
    # error → detail → message → status text
    cases = [
        ({"error": "boom", "detail": "d", "message": "m"}, "boom"),
        ({"detail": "d", "message": "m"}, "d"),
        ({"message": "m"}, "m"),
        ({}, "Unprocessable Content"),
    ]
    for body, expected in cases:
        def handler(request: httpx.Request, body=body) -> httpx.Response:
            return json_response(422, body)

        with make_client(handler) as client:
            with pytest.raises(WritApiError) as excinfo:
                client.agent.status()
        assert excinfo.value.message == expected
        assert excinfo.value.code == "unprocessable"


def test_plain_text_error_maps_status_derived_code():
    text = "Failed to deserialize the JSON body into the target type: missing field `url`"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, headers={"Content-Type": "text/plain"}, content=text.encode())

    with make_client(handler) as client:
        with pytest.raises(WritApiError) as excinfo:
            client.monitors.create({})
    err = excinfo.value
    assert err.status == 400
    assert err.code == "bad_request"
    assert err.message == text
    assert err.body == text


def test_plain_text_error_truncated_to_500_chars():
    text = "x" * 2000

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, headers={"Content-Type": "text/plain"}, content=text.encode())

    with make_client(handler) as client:
        with pytest.raises(WritApiError) as excinfo:
            client.agent.status()
    assert excinfo.value.code == "internal"
    assert len(excinfo.value.message) == 500


def test_status_derived_codes():
    from writ_agent.errors import code_for_status

    assert code_for_status(400) == "bad_request"
    assert code_for_status(401) == "unauthorized"
    assert code_for_status(403) == "forbidden"
    assert code_for_status(404) == "not_found"
    assert code_for_status(409) == "conflict"
    assert code_for_status(422) == "unprocessable"
    assert code_for_status(429) == "rate_limited"
    assert code_for_status(500) == "internal"
    assert code_for_status(503) == "internal"


def test_connection_refused_maps_to_connection_error(dead_port):
    client = WritAgent(f"http://127.0.0.1:{dead_port}", TOKEN)
    with pytest.raises(WritConnectionError):
        client.agent.status()
    client.close()


# ---------------------------------------------------------------------------
# Assorted surface checks
# ---------------------------------------------------------------------------

def test_run_row_id_helper():
    assert run_row_id("workflow-3") == 3
    assert run_row_id("check-127") == 127
    assert run_row_id({"id": "automation-42"}) == 42
    assert run_row_id(9) == 9
    with pytest.raises(ValueError):
        run_row_id("workflow-abc")
    with pytest.raises(ValueError):
        run_row_id({})


def test_secret_key_is_percent_encoded_in_path():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.raw_path.decode().startswith("/v1/secrets/api.key%2Fprod")
        return json_response(200, {"key": "api.key/prod", "name": "api.key/prod"})

    with make_client(handler) as client:
        client.secrets.get("api.key/prod")


def test_ws_ticket_mint():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/ws-ticket"
        body = json.loads(request.content)
        assert body == {"route": "ai-preview", "channel": "ai-7"}
        return json_response(200, {"ticket": "wtk_x", "expires_in_secs": 60})

    with make_client(handler) as client:
        ticket = client.ws_ticket("ai-preview", channel="ai-7")
    assert ticket["ticket"] == "wtk_x"


def test_nested_selector_routes():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/monitors/4/selectors/9/set-baseline"
        return json_response(200, {"selector_id": 9})

    with make_client(handler) as client:
        assert client.selectors.set_baseline(4, 9)["selector_id"] == 9


def test_extractor_toggle_uses_patch():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "PATCH"
        assert request.url.path == "/v1/extractors/2/toggle"
        return json_response(200, {"id": 2, "enabled": 0})

    with make_client(handler) as client:
        assert client.extractors.toggle(2)["enabled"] == 0


def test_recent_changes_bare_array_to_page():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/changes/recent"
        assert request.url.params["limit"] == "5"
        return json_response(200, [{"id": 1}, {"id": 2}])

    with make_client(handler) as client:
        page = client.monitors.recent_changes(limit=5)
    assert page.count == 2 and page.total is None


# ---------------------------------------------------------------------------
# crawl — the Dragnet whole-site crawl (§7; {crawls:[…]} is NOT a Page)
# ---------------------------------------------------------------------------

def _crawl_view(crawl_id: int = 1, **over):
    view = {
        "id": crawl_id,
        "name": "Docs",
        "seed_url": "https://example.com",
        "include_paths": [],
        "exclude_paths": [],
        "max_depth": 3,
        "same_domain": 1,
        "allow_subdomains": 1,
        "extract_mode": "markdown",
        "extract_schema": None,
        "persona_id": None,
        "respect_robots": 1,
        "delay_ms": 250,
        "max_concurrent": 4,
        "page_budget": 500,
        "workflow_id": 42,
        "data_workflow_id": 42,
        "concierge_session_id": None,
        "status": "queued",
        "pages_discovered": 0,
        "pages_done": 0,
        "pages_failed": 0,
        "pages_skipped": 0,
        "workers_active": 0,
        "current_depth": 0,
        "error": None,
        "cancel_requested": 0,
        "brand": "Dragnet",
        "is_terminal": False,
        "created_at": "2026-07-13T00:00:00Z",
        "updated_at": None,
        "started_at": None,
        "completed_at": None,
    }
    view.update(over)
    return view


def test_crawl_list_returns_crawls_object_not_page():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/v1/crawl"
        assert request.url.params["limit"] == "10"
        return json_response(200, {"crawls": [_crawl_view(1), _crawl_view(2)]})

    with make_client(handler) as client:
        result = client.crawl.list(limit=10)
    assert not isinstance(result, Page)
    assert isinstance(result, dict)
    assert [c["id"] for c in result["crawls"]] == [1, 2]
    assert result["crawls"][0]["brand"] == "Dragnet"


def test_crawl_start_posts_body_and_returns_view():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/crawl"
        body = json.loads(request.content)
        assert body == {
            "url": "https://example.com",
            "extract_mode": "schema",
            "extract_schema": {"title": "string"},
            "include_paths": ["^/docs"],
            "max_depth": 2,
            "respect_robots": False,
        }
        return json_response(200, _crawl_view(7, status="queued"))

    with make_client(handler) as client:
        crawl = client.crawl.start(
            "https://example.com",
            extract_mode="schema",
            extract_schema={"title": "string"},
            include_paths=["^/docs"],
            max_depth=2,
            respect_robots=False,
        )
    assert crawl["id"] == 7
    assert crawl["brand"] == "Dragnet"
    assert crawl["data_workflow_id"] == crawl["workflow_id"] == 42


def test_crawl_get_returns_view():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/crawl/9"
        return json_response(200, _crawl_view(9, status="crawling"))

    with make_client(handler) as client:
        crawl = client.crawl.get(9)
    assert crawl["id"] == 9 and crawl["status"] == "crawling"


def test_crawl_cancel_returns_cancel_requested_now():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/crawl/9/cancel"
        return json_response(
            200, _crawl_view(9, status="stopping", cancel_requested_now=True)
        )

    with make_client(handler) as client:
        crawl = client.crawl.cancel(9)
    assert crawl["cancel_requested_now"] is True
    assert crawl["status"] == "stopping"


def test_crawl_get_missing_raises_api_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response(404, {"error": "crawl not found", "code": "not_found"})

    with make_client(handler) as client:
        with pytest.raises(WritApiError) as excinfo:
            client.crawl.get(404)
    assert excinfo.value.status == 404
    assert excinfo.value.code == "not_found"
