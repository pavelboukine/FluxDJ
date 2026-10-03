// Local outbox worker: delivers due emails every few seconds by calling the
// app's protected worker endpoint. Run with `pnpm outbox:work` (reads .env.local).
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";
const secret = process.env.OUTBOX_WORKER_SECRET;
const intervalMs = Number(process.env.OUTBOX_INTERVAL_MS ?? 5000);
const once = process.argv.includes("--once");

if (!secret) {
  console.error("OUTBOX_WORKER_SECRET is not set (see .env.example).");
  process.exit(1);
}

async function tick() {
  try {
    const response = await fetch(`${appUrl}/api/internal/outbox`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) console.error(`[outbox] ${response.status}`, body.status ?? "");
    else if (body.claimed > 0) console.log(`[outbox] claimed ${body.claimed}: sent ${body.sent}, failed ${body.failed}, cancelled ${body.cancelled}`);
  } catch (error) {
    console.error("[outbox] app not reachable:", error.message);
  }
}

await tick();
if (!once) setInterval(tick, intervalMs);
