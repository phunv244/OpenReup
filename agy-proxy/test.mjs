import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-proxy-test-"));

// State for mock Google OAuth + Antigravity Cloud Code upstream
const mockState = {
  acc1Mode: "ok", // "ok" | "quota_429"
  acc2Mode: "ok", // "ok" | "expired_once" | "prompt_reject_once"
  lastEnvelope: null,
  callsByToken: {},
};

function createMockUpstream() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://localhost");
    const auth = req.headers.authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "");

    // 1. OAuth Token Endpoint
    if (url.pathname === "/oauth/token") {
      const params = new URLSearchParams(rawBody);
      const grantType = params.get("grant_type");
      if (grantType === "authorization_code") {
        const code = params.get("code");
        const num = code.includes("2") ? "2" : "1";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: `tok_acc${num}_initial`,
            refresh_token: `ref_acc${num}`,
            expires_in: 3600,
            scope: "email profile",
          })
        );
        return;
      }
      if (grantType === "refresh_token") {
        const ref = params.get("refresh_token");
        const num = ref === "ref_acc2" ? "2" : "1";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: `tok_acc${num}_refreshed`,
            expires_in: 3600,
          })
        );
        return;
      }
    }

    // 2. Google UserInfo
    if (url.pathname === "/oauth/userinfo") {
      const num = token.includes("acc2") ? "2" : "1";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          email: `account${num}@example.com`,
          name: `AGY Account ${num}`,
        })
      );
      return;
    }

    // 3. loadCodeAssist & onboardUser
    if (url.pathname === "/v1internal:loadCodeAssist") {
      const num = token.includes("acc2") ? "2" : "1";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          cloudaicompanionProject: `gcp-proj-${num}`,
          paidTier: { id: "pro-tier", name: "Pro" },
          allowedTiers: [{ id: "pro-tier", isDefault: true }],
        })
      );
      return;
    }

    if (url.pathname === "/v1internal:onboardUser") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ done: true }));
      return;
    }

    // 4. Quota endpoints
    if (url.pathname === "/v1internal:fetchAvailableModels") {
      const isExhausted = token.includes("acc1") && mockState.acc1Mode === "quota_429";
      const resetTime = new Date(Date.now() + 3600_000).toISOString();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models: {
            "gemini-3.8-flash-medium": {
              displayName: "Gemini 3.8 Flash",
              quotaInfo: {
                remainingFraction: isExhausted ? 0 : 0.85,
                resetTime,
              },
            },
          },
        })
      );
      return;
    }

    if (url.pathname === "/v1internal:retrieveUserQuotaSummary") {
      const isExhausted = token.includes("acc1") && mockState.acc1Mode === "quota_429";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                {
                  window: "5h",
                  remainingFraction: isExhausted ? 0 : 0.85,
                  resetTime: new Date(Date.now() + 3600_000).toISOString(),
                },
              ],
            },
          ],
        })
      );
      return;
    }

    // 5. Generation endpoints (:generateContent & :streamGenerateContent)
    if (
      url.pathname === "/v1internal:generateContent" ||
      url.pathname === "/v1internal:streamGenerateContent"
    ) {
      mockState.callsByToken[token] = (mockState.callsByToken[token] || 0) + 1;
      const envelope = JSON.parse(rawBody);
      mockState.lastEnvelope = envelope;

      // Account 1 quota exhausted simulation
      if (token.includes("acc1") && mockState.acc1Mode === "quota_429") {
        const resetIso = new Date(Date.now() + 2 * 3600_000).toISOString();
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "Individual quota reached. Your quota will reset after 2h0m0s",
              details: [{ metadata: { quotaResetTimeStamp: resetIso } }],
            },
          })
        );
        return;
      }

      // Account 2 expired token once -> tests 401 auto refresh + retry
      if (token === "tok_acc2_initial" && mockState.acc2Mode === "expired_once") {
        mockState.acc2Mode = "ok";
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Token expired" } }));
        return;
      }

      // Prompt rejection simulation (when systemInstruction still present)
      if (mockState.acc2Mode === "prompt_reject_once" && envelope.request?.systemInstruction) {
        mockState.acc2Mode = "ok";
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "Resource has been exhausted (e.g. check quota).",
            },
          })
        );
        return;
      }

      const accTag = token.includes("acc2") ? "ACC2" : "ACC1";
      const isStream = url.searchParams.get("alt") === "sse";

      // Check if client sent tools (verify tool cloaking + decloaking)
      const hasTools = envelope.request?.tools?.[0]?.functionDeclarations?.some(
        (f) => f.name === "get_weather_ide"
      );

      if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunk1 = {
          response: {
            responseId: "resp_stream_1",
            modelVersion: envelope.model,
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ thought: true, text: "Đang suy nghĩ..." }],
                },
              },
            ],
          },
        };
        const chunk2 = {
          response: {
            responseId: "resp_stream_1",
            modelVersion: envelope.model,
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: `Xin chào từ ${accTag}!` }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 12, thoughtsTokenCount: 5, candidatesTokenCount: 8, totalTokenCount: 25 },
          },
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.end();
        return;
      }

      const parts = hasTools
        ? [
            {
              thoughtSignature: "sig_test_123",
              functionCall: {
                id: "call_w1",
                name: "get_weather_ide",
                args: { city: "Hanoi" },
              },
            },
          ]
        : [
            { thought: true, text: "Suy luận ngắn." },
            { text: `Phản hồi từ ${accTag} (${envelope.project})` },
          ];

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          response: {
            responseId: "resp_json_1",
            modelVersion: envelope.model,
            candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 20 },
          },
        })
      );
      return;
    }

    res.writeHead(404);
    res.end("Mock route not found: " + url.pathname);
  });
}

async function main() {
  const mockServer = createMockUpstream();
  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  const mockPort = mockServer.address().port;
  const mockBase = `http://127.0.0.1:${mockPort}`;

  // Pick free port for proxy server
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const proxyPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const proxyBase = `http://127.0.0.1:${proxyPort}`;

  const child = spawn(process.execPath, [path.join(__dirname, "server.mjs"), "--port", String(proxyPort), "--host", "127.0.0.1"], {
    env: {
      ...process.env,
      AGY_DATA_DIR: tmpDataDir,
      AGY_BASE_URL: mockBase,
      AGY_OAUTH_AUTH_URL: `${mockBase}/oauth/authorize`,
      AGY_OAUTH_TOKEN_URL: `${mockBase}/oauth/token`,
      AGY_OAUTH_USERINFO_URL: `${mockBase}/oauth/userinfo`,
      AGY_LOAD_PROJECT_URL: `${mockBase}/v1internal:loadCodeAssist`,
      AGY_ONBOARD_URL: `${mockBase}/v1internal:onboardUser`,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  // Wait for server ready
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${proxyBase}/api/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    console.log("1️⃣ Kiểm tra Web Dashboard & /v1/models...");
    const dashRes = await fetch(`${proxyBase}/`);
    assert.equal(dashRes.status, 200);
    const dashHtml = await dashRes.text();
    assert.ok(dashHtml.includes("Antigravity Multi-Account Proxy"));

    const modelsRes = await fetch(`${proxyBase}/v1/models`);
    const modelsJson = await modelsRes.json();
    assert.ok(modelsJson.data.length >= 40);

    console.log("2️⃣ Kiểm tra OAuth Login cho Tài khoản #1 (tự động bắt callback localhost)...");
    const oauth1 = await (await fetch(`${proxyBase}/api/oauth/start`, { method: "POST" })).json();
    assert.ok(oauth1.state && oauth1.redirectUri);
    // Simulate Google redirecting browser back to local callback server
    const cbRes1 = await fetch(`${oauth1.redirectUri}?code=auth_code_1&state=${encodeURIComponent(oauth1.state)}`);
    assert.equal(cbRes1.status, 200);
    const st1 = await (await fetch(`${proxyBase}/api/oauth/status?state=${encodeURIComponent(oauth1.state)}`)).json();
    assert.equal(st1.status, "done");
    assert.equal(st1.account.email, "account1@example.com");
    assert.equal(st1.account.projectId, "gcp-proj-1");

    console.log("3️⃣ Kiểm tra OAuth Login cho Tài khoản #2 (chế độ dán URL thủ công trên VPS/Web)...");
    const oauth2 = await (await fetch(`${proxyBase}/api/oauth/start`, { method: "POST" })).json();
    const manualRes = await fetch(`${proxyBase}/api/oauth/manual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: oauth2.state,
        callbackUrl: `${oauth2.redirectUri}?code=auth_code_2&state=${encodeURIComponent(oauth2.state)}`,
      }),
    });
    const manualJson = await manualRes.json();
    assert.equal(manualRes.status, 200);
    assert.equal(manualJson.account.email, "account2@example.com");
    assert.equal(manualJson.account.priority, 2);

    console.log("4️⃣ Gọi /v1/chat/completions khi TK #1 bình thường (ưu tiên TK #1 + dịch format + tool cloaking)...");
    const chat1 = await fetch(`${proxyBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-4-neon-medium",
        messages: [
          { role: "system", content: "You are OpenCode assistant." },
          { role: "user", content: "Thời tiết Hà Nội thế nào?" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Lấy thời tiết",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: { city: { type: "string", minLength: 1 } },
                required: ["city"],
              },
            },
          },
        ],
      }),
    });
    assert.equal(chat1.status, 200);
    assert.equal(chat1.headers.get("x-agy-account-email"), "account1@example.com");
    assert.equal(chat1.headers.get("x-agy-fallback-count"), "0");
    const chat1Json = await chat1.json();
    // Verify decloaked tool call name (`get_weather_ide` -> `get_weather`)
    assert.equal(chat1Json.choices[0].message.tool_calls[0].function.name, "get_weather");
    assert.equal(chat1Json.choices[0].finish_reason, "tool_calls");
    // Verify Gemini 4 thinkingLevel & prompt rewrite happened on upstream envelope
    assert.equal(mockState.lastEnvelope.model, "gemini-4-neon-medium");
    assert.equal(mockState.lastEnvelope.request.generationConfig.thinkingConfig.thinkingLevel, "medium");
    assert.ok(
      !JSON.stringify(mockState.lastEnvelope.request.systemInstruction).includes("OpenCode"),
      "Competing client prompt should be rewritten"
    );

    console.log("5️⃣ Giả lập TK #1 HẾT QUOTA (429) -> Tự động Fallback tác vụ sang TK #2 (kèm tự refresh token 401)!");
    mockState.acc1Mode = "quota_429";
    mockState.acc2Mode = "expired_once"; // Also test auto OAuth refresh on TK #2 at the same time!

    const askFallback = await fetch(`${proxyBase}/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        prompt: "Xin chào!",
      }),
    });
    assert.equal(askFallback.status, 200);
    assert.equal(askFallback.headers.get("x-agy-account-email"), "account2@example.com");
    assert.equal(askFallback.headers.get("x-agy-fallback-count"), "1");
    const askData = await askFallback.json();
    assert.equal(askData.ok, true);
    assert.equal(askData.text, "Phản hồi từ ACC2 (gcp-proj-2)");
    assert.equal(askData.fallbackCount, 1);

    console.log("6️⃣ Gọi tiếp Streaming SSE: TK #1 đang Cooldown nên vào thẳng TK #2 (0 độ trễ thừa)...");
    const streamRes = await fetch(`${proxyBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        stream: true,
        messages: [{ role: "user", content: "Stream test" }],
      }),
    });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get("x-agy-account-email"), "account2@example.com");
    assert.equal(streamRes.headers.get("x-agy-fallback-count"), "0");
    const sseText = await streamRes.text();
    assert.ok(sseText.includes("Đang suy nghĩ..."));
    assert.ok(sseText.includes("Xin chào từ ACC2!"));
    assert.ok(sseText.includes("data: [DONE]"));

    console.log("7️⃣ Kiểm tra Prompt Rejection (429 rỗng không khóa nhầm tài khoản, tự dời systemInstruction)...");
    mockState.acc2Mode = "prompt_reject_once";
    const prRes = await fetch(`${proxyBase}/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        system: "Some custom instruction",
        prompt: "Hello after move",
      }),
    });
    assert.equal(prRes.status, 200);
    const prJson = await prRes.json();
    assert.ok(prJson.text.includes("ACC2"));

    console.log("8️⃣ Kiểm tra mở khóa TK #1 qua API quản lý -> TK #1 hoạt động trở lại...");
    mockState.acc1Mode = "ok";
    const accs = await (await fetch(`${proxyBase}/api/accounts`)).json();
    const acc1Id = accs.accounts[0].id;
    assert.equal(accs.accounts[0].status, "cooldown");
    await fetch(`${proxyBase}/api/accounts/${acc1Id}/unlock`, { method: "POST" });

    const backTo1 = await fetch(`${proxyBase}/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.8-flash", prompt: "Back to 1" }),
    });
    assert.equal(backTo1.headers.get("x-agy-account-email"), "account1@example.com");

    console.log("\n✅ TẤT CẢ 8 KỊCH BẢN KIỂM THỬ ĐỀU PASS TUYỆT ĐỐI!");
  } finally {
    child.kill("SIGTERM");
    mockServer.close();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("❌ TEST FAILED:", err);
  process.exit(1);
});
