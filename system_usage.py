"""Shared CPU/RAM/GPU/NPU usage telemetry, used by both the OpenVINO Whisper and
VibeVoice BitNet transcription scripts so the Resource Monitor works for either engine.
"""

import json
import re
import subprocess
import threading


def emit_progress(enabled: bool, event: dict) -> None:
    if enabled:
        print(json.dumps(event), flush=True)


def parse_first_float(text: str) -> float | None:
    try:
        match = re.search(r"[-+]?\d*\.?\d+", text or "")
        if not match:
            return None
        return float(match.group(0))
    except Exception:
        return None


def run_powershell(script: str) -> str:
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return ""
    return (proc.stdout or "").strip()


def read_counter(counter_path: str) -> float | None:
    safe_path = counter_path.replace("'", "''")
    out = run_powershell(
        f"(Get-Counter '{safe_path}' -SampleInterval 1 -MaxSamples 1).CounterSamples.CookedValue"
    )
    return parse_first_float(out)


def read_counter_sum(counter_path: str) -> float | None:
    safe_path = counter_path.replace("'", "''")
    out = run_powershell(
        f"$s = Get-Counter '{safe_path}' -ErrorAction SilentlyContinue; "
        "if ($s) { ($s.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum }"
    )
    return parse_first_float(out)


def read_ram_percent() -> float | None:
    out = run_powershell(
        "$os = Get-CimInstance Win32_OperatingSystem; "
        "$total = [double]$os.TotalVisibleMemorySize; "
        "$free = [double]$os.FreePhysicalMemory; "
        "if ($total -gt 0) { (($total - $free) / $total) * 100 }"
    )
    return parse_first_float(out)


def read_npu_telemetry() -> dict:
    npu = read_counter_sum(r"\NPU Engine(*)\Utilization Percentage")
    if npu is not None:
        return {
            "npuPercent": round(npu, 1),
            "npuTelemetryAvailable": True,
            "npuTelemetrySource": "perf-counter",
            "npuTelemetryReason": None,
        }

    device_name = run_powershell(
        "$device = Get-PnpDevice -Class ComputeAccelerator -ErrorAction SilentlyContinue | "
        "Where-Object { $_.FriendlyName -match 'NPU|AI Boost|Intel\\(R\\) AI' } | "
        "Select-Object -First 1 -ExpandProperty FriendlyName; "
        "if ($device) { $device }"
    )
    reason = (
        f"{device_name} is present, but Windows is not exposing an NPU performance counter to PowerShell."
        if device_name
        else "No NPU performance counter was found."
    )
    return {
        "npuPercent": None,
        "npuTelemetryAvailable": False,
        "npuTelemetrySource": None,
        "npuTelemetryReason": reason,
    }


def read_utilization_snapshot() -> dict:
    try:
        cpu = read_counter(r"\Processor(_Total)\% Processor Time")
        ram = read_ram_percent()
        gpu = read_counter_sum(r"\GPU Engine(*)\Utilization Percentage")
        npu = read_npu_telemetry()
        return {
            "cpuPercent": round(cpu, 1) if cpu is not None else None,
            "ramPercent": round(ram, 1) if ram is not None else None,
            "gpuPercent": round(gpu, 1) if gpu is not None else None,
            "npuPercent": npu["npuPercent"],
            "npuTelemetryAvailable": npu["npuTelemetryAvailable"],
            "npuTelemetrySource": npu["npuTelemetrySource"],
            "npuTelemetryReason": npu["npuTelemetryReason"],
        }
    except Exception:
        return {}


def start_usage_emitter(enabled: bool, progress_enabled: bool):
    stop_event = threading.Event()
    thread = None

    if not enabled:
        return stop_event, thread

    def run():
        while not stop_event.is_set():
            usage = read_utilization_snapshot()
            emit_progress(
                progress_enabled,
                {
                    "type": "usage",
                    "cpuPercent": usage.get("cpuPercent"),
                    "ramPercent": usage.get("ramPercent"),
                    "gpuPercent": usage.get("gpuPercent"),
                    "npuPercent": usage.get("npuPercent"),
                    "npuTelemetryAvailable": usage.get("npuTelemetryAvailable"),
                    "npuTelemetrySource": usage.get("npuTelemetrySource"),
                    "npuTelemetryReason": usage.get("npuTelemetryReason"),
                },
            )
            stop_event.wait(1.2)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return stop_event, thread
