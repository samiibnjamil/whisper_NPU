import { spawn } from "child_process";

function runPowershell(script) {
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", script], {
      windowsHide: true,
    });

    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.on("close", () => {
      resolve(stdout.trim());
    });
    child.on("error", () => {
      resolve("");
    });
  });
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

async function readUsage() {
  const cpuOut = await runPowershell(
    "(Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1).CounterSamples.CookedValue"
  );
  const ramOut = await runPowershell(
    "$os = Get-CimInstance Win32_OperatingSystem; " +
      "$total = [double]$os.TotalVisibleMemorySize; " +
      "$free = [double]$os.FreePhysicalMemory; " +
      "if ($total -gt 0) { (($total - $free) / $total) * 100 }"
  );
  const gpuOut = await runPowershell(
    "$s = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue; " +
      "if ($s) { ($s.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum }"
  );
  const npuOut = await runPowershell(
    "$s = Get-Counter '\\NPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue; " +
      "if ($s) { ($s.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum }"
  );

  return {
    cpuPercent: toNumber(cpuOut),
    ramPercent: toNumber(ramOut),
    gpuPercent: toNumber(gpuOut),
    npuPercent: toNumber(npuOut),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const usage = await readUsage();
    res.status(200).json(usage);
  } catch {
    res.status(200).json({
      cpuPercent: null,
      ramPercent: null,
      gpuPercent: null,
      npuPercent: null,
    });
  }
}
