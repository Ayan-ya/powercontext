export class PowerContextClient {
  constructor({ baseUrl, token = "", fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async post(path, payload) {
    const headers = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`PowerContext ${path} returned HTTP ${response.status}: ${body}`);
    }
    return body ? JSON.parse(body) : {};
  }

  createScope({ title, summary, idempotencyKey }) {
    return this.post("/v1/scopes", {
      title,
      summary,
      idempotency_key: idempotencyKey,
    });
  }

  saveTaskState(scopeId, state) {
    const taskId = String(state.taskId ?? "").trim();
    if (!taskId) throw new Error("Task state requires taskId");
    return this.post("/v1/memory/remember", {
      scope_id: scopeId,
      kind: "decision",
      text: [
        `task_id ${taskId}`,
        `status ${state.status ?? "in_progress"}`,
        `completed ${JSON.stringify(state.completed ?? [])}`,
        `todo ${JSON.stringify(state.todo ?? [])}`,
        `verification ${JSON.stringify(state.verification ?? [])}`,
      ].join("\n"),
      reason: "Persisted SDD task progress for restart-safe continuation.",
    });
  }

  prepareTaskState(scopeId, taskId) {
    return this.post("/v1/context/prepare", {
      scope_id: scopeId,
      query: `task_id ${taskId} status completed todo verification`,
      max_bytes: 6000,
    });
  }
}
