import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tự động nạp biến môi trường từ .env (thư mục gốc dự án hoặc agy-proxy/.env), không ghi đè biến đã set sẵn
const __constDir = path.dirname(fileURLToPath(import.meta.url));
function loadDotEnvFiles() {
  const candidates = [
    path.resolve(__constDir, "..", ".env"),
    path.resolve(__constDir, "..", "..", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    } catch {}
  }
}
loadDotEnvFiles();

// Official Antigravity Hub Desktop fingerprint (macOS arm64 — static by design, matching 9router)
export const ANTIGRAVITY_IDE_VERSION = "2.33.0";
export const ANTIGRAVITY_IDE_USER_AGENT = `antigravity/hub/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;
export const ANTIGRAVITY_BASE_URL =
  process.env.AGY_BASE_URL || "https://daily-cloudcode-pa.googleapis.com";

export const ANTIGRAVITY_OAUTH = {
  clientId: process.env.AGY_CLIENT_ID || "",
  clientSecret: process.env.AGY_CLIENT_SECRET || "",
  authorizeUrl:
    process.env.AGY_OAUTH_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl:
    process.env.AGY_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token",
  userInfoUrl:
    process.env.AGY_OAUTH_USERINFO_URL || "https://www.googleapis.com/oauth2/v1/userinfo",
  loadCodeAssistEndpoint:
    process.env.AGY_LOAD_PROJECT_URL ||
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  onboardUserEndpoint:
    process.env.AGY_ONBOARD_URL ||
    "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
  quotaApiUrl: `${ANTIGRAVITY_BASE_URL}/v1internal:fetchAvailableModels`,
  quotaSummaryApiUrl: `${ANTIGRAVITY_BASE_URL}/v1internal:retrieveUserQuotaSummary`,
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  refreshLeadMs: 5 * 60 * 1000, // Refresh token 5 minutes before expiry
};

export function getPlatformEnum() {
  const p = os.platform();
  const a = os.arch();
  if (p === "darwin") return a === "arm64" ? 2 : 1;
  if (p === "linux") return a === "arm64" ? 4 : 3;
  if (p === "win32") return 5;
  return 0;
}

export function getClientMetadata() {
  return {
    ideType: 9, // ANTIGRAVITY
    platform: getPlatformEnum(),
    pluginType: 2, // GEMINI
  };
}

// Default signature for Gemini 3+/4 thinking/tool-call history when client doesn't persist thoughtSignature
export const DEFAULT_THINKING_AG_SIGNATURE =
  "EuwGCukGAXLI2nxwZIq54WWSoL/YN0P3TsDZ7zRnLi8g0S4aVr2HUGxvaHKySuY6HAVzcE0GPGjXrytLIldxthSvfxgUlJh6Qa9Z+Oj5QZBlYdg6HaJ6yuY5R7waE6rdwBsRf7Ft2j3DJ9rMi9qhWFqApewYtPhls3VHtuvND3l8Rm09+lbAXQs6KKWEWrxNLKTBkfpMgXhRERc/TQRMZu1twAablm6/Zk1tsYRvfWKLsNbeKF+CCojJdXJKvnR/8Ouuoa+Y2Ti20hcW7aZIIjZDFYPU//k6Ybmhg69J/imbFai2ckhfLaisqdDkdoIiBJScTOUvYqP6AE9d4MsydSC+UlhIMk4hoP76R8vUSCZRMkjOaDXstf/QoVZKbt94wyRZgAJ1G0BqI8L5ow86kLpA4wJEtxsRGymOE4bKUvApveBakYDNM9APkf+LbtbzWSseGjoZcSlycF9iN8Q2XNYKRrHbv3Lr5Y8JjdH/5y/6SHkNehTEZugaeGnSPSyCTWto1kQgHpxdWmhkLfJGNUGLmue7Mesj4TSms4J33mRpYVhNB/J333FCqIP0hr/E7BkkjEn7yZ4X7SQlh+xKPurapsnHRwiKmtsilmEFrnTE9iQr+pMr6M29qqFNv1tr5yumbaJw8JW9sB15tNsRv+dW6BjNanbsKz7HCgKUBc8tGy+7YuhXzAfViyRefcjK7eZW0Fbyt7AbybJTKz78W8NH7ye6LAwzOebXpeZ4D43fNIt8bKh26qgduSQv/7o+pAflkuqHZ99YWgHQ8h8OkZFi3eOiSYjsjhdZ/czWOdoPI/OnqIldzMPF5YlrKBLFX8VhRKVmqgsmWf5PHGulHhMkVlS+XG2UIseGy69ARa93D78Gsa+1n1kJr7EEB7Rh+27vUMxVYLdz1yMSvE5nalTAlg/ZeG8+XQ0cHuAI3KbQpHW2Q++RdXfm5JzD5WdJZUU+Zn8t8UUn85BH4RxZLeE0qJikgSsKoYVBc6YhiMjhPgkR95ReimY4Z0xCJdRo1gjexOFeODZMpQF6Yxnoic7IrdgsFA3iePTbFnPp3IAM1fAThWhXJUn3QInUOTd5o1qmTmn6REbL15g/JQNl+dqUoPkhleeb2V3kjqp1okmO3wMZbPknR3S1LZNmlS72/iBQUm+n2b/RCn4PjmM2";

// Official Antigravity 2.33.0 identity prepended to systemInstruction
export const ANTIGRAVITY_DEFAULT_SYSTEM =
  "You are Antigravity Agent, a powerful agentic AI coding assistant designed by the Google engineering team.\n" +
  "You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n" +
  "The USER will send you requests, which you must always prioritize addressing. User requests are enclosed within <USER_REQUEST> tags.";

// Competing-client system prompt strings that trigger fake 429 RESOURCE_EXHAUSTED on Antigravity
export const ANTIGRAVITY_PROMPT_REWRITES = [
  { from: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", to: "" },
  { from: /^[ \t]*You are Hermes Agent, built by Nous Research\. Be direct:[^\n]*/gm, to: "You are an AI assistant." },
  { from: /^[ \t]*<!-- End Hermes runtime environment -->[^\n]*(?:\r?\n)?/gm, to: "" },
  { from: /^[ \t]*# Google model operational directives[^\n]*(?:\r?\n)?/gm, to: "" },
  { from: /^[ \t]*If a tool, install, or network call fails and blocks the real path[^\n]*(?:\r?\n)?/gm, to: "" },
  { from: /^[ \t]*When the user asks you to build, run, or verify something, the deliverable is a working artifact[^\n]*(?:\r?\n)?/gm, to: "" },
  { from: /^[ \t]*For help with Hermes Agent itself[^\n]*(?:\r?\n)?/gm, to: "" },
  { from: /^[ \t]*Mid-turn, the user can steer you: Hermes delivers their message[^\n]*(?:\r?\n)?/gm, to: "" },
  { from: /You are Hermes(?: Agent)?(?:,\s*(?:an intelligent AI assistant|an AI assistant|an AI agent))?(?:,?\s*(?:built|created)\s+by\s+Nous Research)?\./gi, to: "You are an AI assistant." },
  { from: /^x-anthropic-billing-header:[^\n]*(?:\r?\n)*/gim, to: "" },
  { from: /opencode/gi, to: (m) => (m === "OpenCode" ? "Antigravity" : m === "OPENCODE" ? "ANTIGRAVITY" : "antigravity") },
  { from: /You are a personal assistant running inside OpenClaw\./gi, to: "You are a personal assistant running inside Antigravity." },
];

export const AG_TOOL_SUFFIX = "_ide";

export const AG_DEFAULT_TOOLS = new Set([
  "browser_subagent",
  "command_status",
  "find_by_name",
  "generate_image",
  "grep_search",
  "list_dir",
  "list_resources",
  "multi_replace_file_content",
  "notify_user",
  "read_resource",
  "read_terminal",
  "read_url_content",
  "replace_file_content",
  "run_command",
  "search_web",
  "send_command_input",
  "task_boundary",
  "view_content_chunk",
  "view_file",
  "write_to_file",
]);

export const AG_DECOY_TOOLS = [
  "browser_subagent",
  "command_status",
  "find_by_name",
  "generate_image",
  "grep_search",
  "list_dir",
  "list_resources",
  "mcp_sequential-thinking_sequentialthinking",
  "multi_replace_file_content",
  "notify_user",
  "read_resource",
  "read_terminal",
  "read_url_content",
  "replace_file_content",
  "run_command",
  "search_web",
  "send_command_input",
  "task_boundary",
  "view_content_chunk",
  "view_file",
  "write_to_file",
].map((name) => ({
  name,
  description: "This tool is currently unavailable.",
  parameters: { type: "OBJECT", properties: {}, required: [] },
}));

export const ANTIGRAVITY_MODELS = [
  { id: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)", upstreamModelId: "gemini-4-neon-xhigh(xhigh)" },
  { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)", upstreamModelId: "gemini-4-neon-high(high)" },
  { id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)", upstreamModelId: "gemini-4-neon-medium(medium)" },
  { id: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)", upstreamModelId: "gemini-4-neon-low(low)" },
  { id: "gemini-4-neon", name: "Gemini 4 Neon", upstreamModelId: "gemini-4-neon-high(high)" },
  { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)", upstreamModelId: "gemini-4-carbon-high(high)" },
  { id: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)", upstreamModelId: "gemini-4-carbon-medium(medium)" },
  { id: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)", upstreamModelId: "gemini-4-carbon-low(low)" },
  { id: "gemini-4-carbon", name: "Gemini 4 Carbon", upstreamModelId: "gemini-4-carbon-high(high)" },
  { id: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)", upstreamModelId: "gemini-4-hydrogen-xhigh(xhigh)" },
  { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)", upstreamModelId: "gemini-4-hydrogen-high(high)" },
  { id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)", upstreamModelId: "gemini-4-hydrogen-medium(medium)" },
  { id: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)", upstreamModelId: "gemini-4-hydrogen-low(low)" },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", upstreamModelId: "gemini-4-hydrogen-high(high)" },
  { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", upstreamModelId: "gemini-4-argon-high(high)" },
  { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", upstreamModelId: "gemini-4-argon-medium(medium)" },
  { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", upstreamModelId: "gemini-4-argon-low(low)" },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", upstreamModelId: "gemini-4-argon-high(high)" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", upstreamModelId: "gemini-3.8-flash-high(high)" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", upstreamModelId: "gemini-3.8-flash-medium(medium)" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", upstreamModelId: "gemini-3.8-flash-low(low)" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", upstreamModelId: "gemini-3.8-flash-medium(medium)" },
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", upstreamModelId: "gemini-3.7-flash-tiered(high)" },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", upstreamModelId: "gemini-3.7-flash-tiered(medium)" },
  { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", upstreamModelId: "gemini-3.7-flash-tiered(low)" },
  { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", upstreamModelId: "gemini-3.6-flash-tiered(high)" },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", upstreamModelId: "gemini-3.6-flash-tiered(medium)" },
  { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", upstreamModelId: "gemini-3.6-flash-tiered(low)" },
  { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", upstreamModelId: "gemini-pro-agent" },
  { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", upstreamModelId: "gemini-pro-agent" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", upstreamModelId: "gemini-3.1-pro-low(low)" },
  { id: "claude-sonnet-5-5-max", name: "Claude Sonnet 5.5 (Max)", upstreamModelId: "claude-sonnet-5-5-max(max)" },
  { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", upstreamModelId: "claude-sonnet-5-5-high(high)" },
  { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", upstreamModelId: "claude-sonnet-5-5-medium(medium)" },
  { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", upstreamModelId: "claude-sonnet-5-5-low(low)" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (Thinking)", upstreamModelId: "claude-sonnet-5-5-medium(medium)" },
  { id: "claude-opus-5-5-max", name: "Claude Opus 5.5 (Max)", upstreamModelId: "claude-opus-5-5-max(max)" },
  { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", upstreamModelId: "claude-opus-5-5-high(high)" },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", upstreamModelId: "claude-opus-5-5-medium(medium)" },
  { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", upstreamModelId: "claude-opus-5-5-low(low)" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5 (Thinking)", upstreamModelId: "claude-opus-5-5-medium(medium)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
  { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash (Image)", kind: "image", imageGen: true },
];

export const MODEL_MAP = new Map(ANTIGRAVITY_MODELS.map((m) => [m.id, m]));

export const DEFAULT_MODEL = "gemini-3.8-flash";
