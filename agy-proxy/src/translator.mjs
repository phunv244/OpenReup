import crypto from "node:crypto";
import {
  MODEL_MAP,
  DEFAULT_MODEL,
  DEFAULT_THINKING_AG_SIGNATURE,
  ANTIGRAVITY_DEFAULT_SYSTEM,
  ANTIGRAVITY_PROMPT_REWRITES,
  AG_TOOL_SUFFIX,
  AG_DEFAULT_TOOLS,
  AG_DECOY_TOOLS,
} from "./constants.mjs";

// ─── Thought Signature Cache (prevents 400 on Gemini 3+/4 tool loops) ─────────

const thoughtSigCache = new Map();
const MAX_SIG_CACHE = 500;

export function storeThoughtSignature(callId, sig) {
  if (!callId || !sig) return;
  if (thoughtSigCache.size >= MAX_SIG_CACHE) {
    const oldest = thoughtSigCache.keys().next().value;
    thoughtSigCache.delete(oldest);
  }
  thoughtSigCache.set(callId, sig);
}

export function getCachedThoughtSignature(callId) {
  return callId ? thoughtSigCache.get(callId) || null : null;
}

// ─── Model & Capability Helpers ───────────────────────────────────────────────

export function normalizeRequestedModel(rawModel, defaultModel = DEFAULT_MODEL) {
  let m = String(rawModel || defaultModel || DEFAULT_MODEL).trim();
  // Strip context marker e.g. [1m]
  m = m.replace(/\[\d+[mk]\]$/i, "");
  // Strip provider prefix e.g. ag/ or antigravity/
  if (m.startsWith("antigravity/")) m = m.slice("antigravity/".length);
  else if (m.startsWith("ag/")) m = m.slice("ag/".length);

  const reg = MODEL_MAP.get(m);
  const upstreamWithSuffix = reg?.upstreamModelId || m;
  const { cleanModel, override } = parseThinkingSuffix(upstreamWithSuffix);
  return {
    requestedId: m,
    upstreamWithSuffix,
    cleanModel,
    suffixThinking: override,
    isImage: isImageModel(cleanModel),
  };
}

export function isImageModel(model) {
  return /image|imagen|image-generation/i.test(String(model || ""));
}

export function isGemini4Model(model) {
  return /(?:^|\/)gemini-4(?:$|[-.])/i.test(String(model || ""));
}

const LEVEL_TO_BUDGET = {
  none: 0,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 128000,
};

export function parseThinkingSuffix(model) {
  if (typeof model !== "string") return { cleanModel: model, override: null };
  const m = model.match(/^(.*)\(([^()]+)\)\s*$/);
  if (!m) return { cleanModel: model, override: null };
  const cleanModel = m[1].trim();
  const raw = m[2].trim().toLowerCase();
  if (raw === "none" || raw === "off") return { cleanModel, override: { mode: "none" } };
  if (raw === "auto") return { cleanModel, override: { mode: "auto" } };
  if (/^\d+$/.test(raw)) return { cleanModel, override: { mode: "budget", budget: Number(raw) } };
  if (LEVEL_TO_BUDGET[raw] !== undefined) return { cleanModel, override: { mode: "level", level: raw } };
  return { cleanModel, override: null };
}

function extractClientThinkingIntent(body) {
  if (!body || typeof body !== "object") return null;
  const effort = body.reasoning_effort ?? (typeof body.reasoning === "object" ? body.reasoning?.effort : null);
  if (typeof effort === "string" && effort) {
    const e = effort.toLowerCase().trim();
    if (e === "none" || e === "off") return { mode: "none" };
    if (e === "auto") return { mode: "auto" };
    return { mode: "level", level: e };
  }
  if (body.thinking && typeof body.thinking === "object") {
    if (body.thinking.type === "disabled") return { mode: "none" };
    if (body.thinking.type === "enabled" || body.thinking.type === "adaptive") {
      const b = Number(body.thinking.budget_tokens);
      return Number.isFinite(b) && b > 0 ? { mode: "budget", budget: b } : { mode: "auto" };
    }
  }
  return null;
}

function getModelThinkingRule(cleanModel) {
  const m = String(cleanModel || "").toLowerCase();
  if (isImageModel(m)) return { reasoning: false };
  if (m.includes("gemini-4-neon") || m.includes("gemini-4-hydrogen")) {
    return {
      reasoning: true,
      format: "gemini-level",
      levels: ["low", "medium", "high", "xhigh"],
      canDisable: false,
      maxOutput: 65536,
      longDecode: m.includes("hydrogen"),
    };
  }
  if (m.includes("gemini-4")) {
    return {
      reasoning: true,
      format: "gemini-level",
      levels: ["low", "medium", "high"],
      canDisable: false,
      maxOutput: 65536,
    };
  }
  if (m.includes("gemini-3")) {
    return {
      reasoning: true,
      format: "gemini-level",
      levels: ["minimal", "low", "medium", "high"],
      canDisable: false,
      maxOutput: 65535,
    };
  }
  if (m.includes("claude") && (m.includes("5-5") || m.includes("5.5"))) {
    return {
      reasoning: true,
      format: "gemini-level",
      levels: ["low", "medium", "high", "max"],
      canDisable: false,
      maxOutput: 64000,
    };
  }
  if (m.includes("claude") && (m.includes("4-6") || m.includes("4.6"))) {
    return {
      reasoning: true,
      format: "gemini-level",
      levels: ["low", "medium", "high", "max"],
      canDisable: true,
      maxOutput: 64000,
    };
  }
  if (m.includes("claude") || m.includes("gemini-2.5")) {
    return {
      reasoning: true,
      format: "gemini-budget",
      canDisable: true,
      maxOutput: 64000,
    };
  }
  return { reasoning: false, maxOutput: 64000 };
}

function budgetToLevel(budget) {
  const b = Number(budget);
  if (!b || b <= 0) return null;
  if (b <= 768) return "minimal";
  if (b <= 4096) return "low";
  if (b <= 16384) return "medium";
  if (b <= 28672) return "high";
  if (b <= 80384) return "xhigh";
  return "max";
}

const LEVEL_OUTPUT_FLOOR = {
  minimal: 4096,
  low: 8192,
  medium: 16384,
  high: 65535,
  xhigh: 65535,
  max: 64000,
};

function applyAntigravityThinking(generationConfig, cleanModel, thinkingCfg) {
  const rule = getModelThinkingRule(cleanModel);
  if (!rule.reasoning || !thinkingCfg) return;

  if (rule.format === "gemini-level") {
    if (thinkingCfg.mode === "none" && rule.canDisable) {
      generationConfig.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
      return;
    }
    let level = "high";
    if (thinkingCfg.mode === "level") level = thinkingCfg.level;
    else if (thinkingCfg.mode === "budget") level = budgetToLevel(thinkingCfg.budget) || "medium";
    else if (thinkingCfg.mode === "none") level = "minimal";

    if (rule.levels?.length && !rule.levels.includes(level)) {
      if (level === "max" && rule.levels.includes("xhigh")) level = "xhigh";
      else if ((level === "max" || level === "xhigh") && rule.levels.includes("high")) level = "high";
      else level = rule.levels[0];
    }

    generationConfig.thinkingConfig = {
      thinkingLevel: level,
      includeThoughts: level !== "minimal",
    };
    const floor = Math.min(LEVEL_OUTPUT_FLOOR[level] || 32768, rule.maxOutput || 64000);
    if (!Number.isFinite(generationConfig.maxOutputTokens) || generationConfig.maxOutputTokens < floor) {
      generationConfig.maxOutputTokens = floor;
    }
  } else if (rule.format === "gemini-budget") {
    if (thinkingCfg.mode === "none" && rule.canDisable) {
      generationConfig.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
      return;
    }
    const budget =
      thinkingCfg.mode === "budget"
        ? thinkingCfg.budget
        : thinkingCfg.mode === "level"
          ? LEVEL_TO_BUDGET[thinkingCfg.level] ?? 8192
          : -1;
    generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
    const floor = budget > 0 && budget <= 8192 ? 16384 : 32768;
    if (!Number.isFinite(generationConfig.maxOutputTokens) || generationConfig.maxOutputTokens < floor) {
      generationConfig.maxOutputTokens = floor;
    }
  }
}

// ─── JSON Schema Sanitizer for Gemini / Antigravity ───────────────────────────

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "format", "multipleOf", "uniqueItems", "contains",
  "unevaluatedProperties", "unevaluatedItems", "contentSchema",
  "prefixItems", "additionalItems", "default", "examples",
  "$schema", "$defs", "definitions", "const", "$ref", "$comment",
  "deprecated", "readOnly", "writeOnly",
  "additionalProperties", "propertyNames", "patternProperties", "enumDescriptions",
  "anyOf", "oneOf", "allOf", "not",
  "dependencies", "dependentSchemas", "dependentRequired",
  "title", "optional", "~optional", "if", "then", "else", "contentMediaType", "contentEncoding",
  "errorMessage", "errorMessages", "markdownDescription", "minProperties", "maxProperties",
]);

export function cleanJSONSchemaForAntigravity(rawSchema) {
  if (!rawSchema || typeof rawSchema !== "object") return rawSchema;
  const schema = structuredClone(rawSchema);

  const walkPrepare = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) return obj.forEach(walkPrepare);
    if (obj.const !== undefined && !obj.enum) {
      obj.enum = [obj.const];
      delete obj.const;
    }
    if (Array.isArray(obj.enum)) {
      obj.enum = obj.enum.map((v) => String(v));
      if (!obj.type) obj.type = "string";
    }
    if (Array.isArray(obj.allOf)) {
      const props = {};
      const reqs = new Set(Array.isArray(obj.required) ? obj.required : []);
      for (const sub of obj.allOf) {
        if (sub?.properties) Object.assign(props, sub.properties);
        if (Array.isArray(sub?.required)) sub.required.forEach((r) => reqs.add(r));
      }
      delete obj.allOf;
      if (Object.keys(props).length) obj.properties = { ...(obj.properties || {}), ...props };
      if (reqs.size) obj.required = [...reqs];
    }
    if (Array.isArray(obj.prefixItems) && obj.prefixItems.length) {
      const variants = obj.prefixItems.filter((s) => s && s.type !== "null");
      if (!obj.items && variants.length === 1) obj.items = variants[0];
      else if (!obj.items && variants.length > 1) obj.items = { anyOf: variants };
      delete obj.prefixItems;
    }
    for (const key of ["anyOf", "oneOf"]) {
      if (Array.isArray(obj[key]) && obj[key].length) {
        const nonNull = obj[key].filter((s) => s && s.type !== "null");
        if (nonNull.length) {
          const picked =
            nonNull.find((s) => s.type === "object" || s.properties) ||
            nonNull.find((s) => s.type === "array" || s.items) ||
            nonNull[0];
          delete obj[key];
          Object.assign(obj, picked);
        }
      }
    }
    if (Array.isArray(obj.type)) {
      const nonNull = obj.type.filter((t) => t !== "null");
      obj.type = nonNull[0] || "string";
    }
    for (const v of Object.values(obj)) if (v && typeof v === "object") walkPrepare(v);
  };

  const walkClean = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) return obj.forEach(walkClean);
    for (const k of Object.keys(obj)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(k) || k.startsWith("x-")) {
        delete obj[k];
        continue;
      }
      if (obj[k] && typeof obj[k] === "object") walkClean(obj[k]);
    }
    if (obj.properties && !obj.type) obj.type = "object";
    if (obj.type === "array") {
      delete obj.properties;
      delete obj.required;
      if (!obj.items || typeof obj.items !== "object" || !Object.keys(obj.items).length) {
        obj.items = { type: "string" };
      } else if (!obj.items.type) {
        obj.items.type = obj.items.properties ? "object" : obj.items.items ? "array" : "string";
      }
    } else {
      delete obj.items;
    }
    if (obj.type !== "object") {
      delete obj.properties;
      delete obj.required;
    } else {
      if (Array.isArray(obj.required) && obj.properties) {
        obj.required = obj.required.filter((f) => Object.prototype.hasOwnProperty.call(obj.properties, f));
        if (!obj.required.length) delete obj.required;
      }
      if (!obj.properties || !Object.keys(obj.properties).length) {
        obj.properties = {
          reason: { type: "string", description: "Brief explanation of why you are calling this tool" },
        };
        obj.required = ["reason"];
      }
    }
  };

  walkPrepare(schema);
  if (!Object.keys(schema).length) {
    return {
      type: "object",
      properties: { reason: { type: "string", description: "Brief explanation" } },
      required: ["reason"],
    };
  }
  walkClean(schema);
  return schema;
}

function sanitizeFunctionName(name) {
  if (!name) return "_unknown";
  let s = String(name).replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
  return s.slice(0, 64);
}

// ─── Content & Message Normalization ──────────────────────────────────────────

function safeParseJSON(str, fallback = null) {
  if (str && typeof str === "object") return str;
  if (typeof str !== "string") return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function sanitizeFunctionResponsePayload(val) {
  if (Array.isArray(val)) return val.map(sanitizeFunctionResponsePayload);
  if (!val || typeof val !== "object") return val;
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    out[k === "$ref" ? "_ref" : k] = sanitizeFunctionResponsePayload(v);
  }
  return out;
}

async function convertUserContentToParts(content) {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push({ text: item.text });
    } else if (item.type === "image_url" && item.image_url?.url) {
      const url = item.image_url.url;
      if (url.startsWith("data:")) {
        const comma = url.indexOf(",");
        if (comma !== -1) {
          const mimeType = url.slice(5, comma).split(";")[0] || "image/png";
          const data = url.slice(comma + 1);
          parts.push({ inlineData: { mime_type: mimeType, data } });
        }
      } else if (url.startsWith("http://") || url.startsWith("https://")) {
        // Prefetch remote image to base64 inlineData so Cloud Code never rejects external URLs
        try {
          const res = await fetch(url);
          if (res.ok) {
            const mimeType = (res.headers.get("content-type") || "image/png").split(";")[0];
            const buf = Buffer.from(await res.arrayBuffer());
            parts.push({ inlineData: { mime_type: mimeType, data: buf.toString("base64") } });
          } else {
            parts.push({ fileData: { fileUri: url, mimeType: "image/png" } });
          }
        } catch {
          parts.push({ fileData: { fileUri: url, mimeType: "image/png" } });
        }
      }
    } else if (item.type === "input_audio" && item.input_audio?.data) {
      const fmt = item.input_audio.format || "wav";
      parts.push({
        inlineData: { mime_type: fmt === "mp3" ? "audio/mpeg" : `audio/${fmt}`, data: item.input_audio.data },
      });
    }
  }
  return parts;
}

function extractPlainText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

export function normalizeGeminiContents(contents, model = null) {
  const frLast = isGemini4Model(model);
  const out = [];
  for (const c of contents || []) {
    if (!c?.role || !Array.isArray(c.parts)) continue;
    const parts = c.parts
      .filter((p) => p && Object.keys(p).length > 0)
      .map((p) => {
        if (!p.functionResponse?.response) return p;
        return {
          ...p,
          functionResponse: {
            ...p.functionResponse,
            response: sanitizeFunctionResponsePayload(p.functionResponse.response),
          },
        };
      });
    if (!parts.length) continue;
    const last = out.at(-1);
    if (last?.role === c.role) {
      last.parts.push(...parts);
      if (frLast) {
        const frs = last.parts.filter((p) => p.functionResponse);
        if (frs.length) {
          last.parts = [...last.parts.filter((p) => !p.functionResponse), ...frs];
        }
      }
    } else {
      out.push({ role: c.role, parts: [...parts] });
    }
  }

  if (out.length > 0 && out[0].role !== "user") {
    out.unshift({ role: "user", parts: [{ text: "..." }] });
  }
  if (out.length > 0 && out.at(-1).role === "model") {
    const fnCalls = (out.at(-1).parts || []).filter((p) => p?.functionCall);
    if (fnCalls.length) {
      out.push({
        role: "user",
        parts: fnCalls.map((p) => ({
          functionResponse: {
            ...(p.functionCall.id ? { id: p.functionCall.id } : {}),
            name: p.functionCall.name || "tool",
            response: { result: "Continue." },
          },
        })),
      });
    } else {
      out.push({ role: "user", parts: [{ text: "Continue." }] });
    }
  }
  return out;
}

// ─── ID Generators & Tool Cloaking ────────────────────────────────────────────

function uuidFromSeed(seed) {
  const bytes = crypto.createHash("sha256").update(String(seed || "antigravity")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toNumericSessionId(seed) {
  const hash = crypto.createHash("sha256").update(String(seed || "session")).digest();
  // Positive 63-bit integer string matching Antigravity IDE numeric sessionId
  const n = hash.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${n.toString()}`;
}

function generateFallbackProjectId() {
  const adj = ["useful", "bright", "swift", "calm", "bold"][Math.floor(Math.random() * 5)];
  const noun = ["fuze", "wave", "spark", "flow", "core"][Math.floor(Math.random() * 5)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

function buildIdeRequestId({ sessionId, model, contentsCount, requestType }) {
  const convId = uuidFromSeed(`antigravity:conversation:${sessionId}`);
  const trajId = uuidFromSeed(`antigravity:trajectory:${sessionId}:${model}:${requestType}`);
  const step = Math.max(1, (contentsCount || 1) * 2 - 1);
  return `agent/${convId}/${Date.now()}/${trajId}/${step}`;
}

function cloakToolsAndHistory(tools, contents) {
  if (!tools || !tools.length) return { tools: undefined, contents, toolNameMap: null };

  const toolNameMap = new Map();
  const clientDecls = [];
  for (const group of tools) {
    for (const fn of group.functionDeclarations || []) {
      if (AG_DEFAULT_TOOLS.has(fn.name)) {
        clientDecls.push(fn);
        continue;
      }
      const suffixed = `${fn.name}${AG_TOOL_SUFFIX}`.slice(0, 64);
      toolNameMap.set(suffixed, fn.name);
      clientDecls.push({ ...fn, name: suffixed });
    }
  }

  const allDeclarations = [];
  const seen = new Set();
  for (const d of [...clientDecls, ...AG_DECOY_TOOLS]) {
    if (!d?.name || seen.has(d.name)) continue;
    seen.add(d.name);
    allDeclarations.push(d);
  }

  const cloakedContents = (contents || []).map((msg) => {
    if (!Array.isArray(msg.parts)) return msg;
    return {
      ...msg,
      parts: msg.parts.map((part) => {
        if (part.functionCall && !AG_DEFAULT_TOOLS.has(part.functionCall.name)) {
          return {
            ...part,
            functionCall: {
              ...part.functionCall,
              name: `${part.functionCall.name}${AG_TOOL_SUFFIX}`.slice(0, 64),
            },
          };
        }
        if (part.functionResponse && !AG_DEFAULT_TOOLS.has(part.functionResponse.name)) {
          return {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              name: `${part.functionResponse.name}${AG_TOOL_SUFFIX}`.slice(0, 64),
            },
          };
        }
        return part;
      }),
    };
  });

  return {
    tools: [{ functionDeclarations: allDeclarations }],
    contents: cloakedContents,
    toolNameMap,
  };
}

function parseImageAspectRatio(model) {
  const m = String(model || "").match(/(\d+)x(\d+)$/);
  if (!m) return { aspectRatio: "1:1" };
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (w <= 16 && h <= 16) return { aspectRatio: `${w}:${h}` };
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const d = gcd(w, h);
  return { aspectRatio: `${w / d}:${h / d}` };
}

// ─── Main OpenAI -> Antigravity Request Builder ───────────────────────────────

export async function buildAntigravityEnvelope(body, modelMeta, account, { sessionHint = "" } = {}) {
  const { cleanModel, suffixThinking, isImage } = modelMeta;
  const projectId = account?.projectId || generateFallbackProjectId();
  const sessionSeed = sessionHint || body.user || account?.email || account?.id || "agy-proxy";
  const sessionId = toNumericSessionId(sessionSeed);

  const messages = Array.isArray(body.messages) ? body.messages : [];

  // Image generation path
  if (isImage) {
    const cleanImgModel = cleanModel.replace(/-(\d+)x(\d+)$/, "");
    const contents = [];
    for (const msg of messages) {
      if (msg.role === "system") continue;
      const parts = await convertUserContentToParts(msg.content);
      if (parts.length) {
        contents.push({ role: msg.role === "assistant" ? "model" : "user", parts });
      }
    }
    if (!contents.length && typeof body.prompt === "string") {
      contents.push({ role: "user", parts: [{ text: body.prompt }] });
    }
    const request = {
      contents,
      generationConfig: {
        temperature: 1.0,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
        imageConfig: parseImageAspectRatio(cleanModel),
      },
      sessionId,
    };
    return {
      envelope: {
        project: projectId,
        model: cleanImgModel,
        userAgent: "antigravity",
        requestType: "image_gen",
        requestId: buildIdeRequestId({
          sessionId,
          model: cleanImgModel,
          contentsCount: contents.length,
          requestType: "image_gen",
        }),
        request,
      },
      toolNameMap: null,
    };
  }

  // Queue tool responses by tool_call_id so duplicate IDs across long sessions never collide
  const toolResponses = {};
  const toolCursor = {};
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      (toolResponses[msg.tool_call_id] ||= []).push(msg.content);
    }
  }

  const usedCallIds = new Set();
  const nextUniqueCallId = (id) => {
    if (!id) return `call_${crypto.randomUUID().slice(0, 8)}`;
    if (!usedCallIds.has(id)) {
      usedCallIds.add(id);
      return id;
    }
    let n = 2;
    while (usedCallIds.has(`${id}-${n}`)) n++;
    const c = `${id}-${n}`;
    usedCallIds.add(c);
    return c;
  };

  const systemTexts = [];
  const rawContents = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if ((msg.role === "system" || msg.role === "developer") && messages.length > 1) {
      const t = extractPlainText(msg.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (msg.role === "user" || ((msg.role === "system" || msg.role === "developer") && messages.length === 1)) {
      const parts = await convertUserContentToParts(msg.content);
      if (parts.length) rawContents.push({ role: "user", parts });
      continue;
    }

    if (msg.role === "assistant") {
      const parts = [];
      const text = extractPlainText(msg.content);
      if (text) parts.push({ text });

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const emittedCalls = [];
        let firstSeen = false;
        for (const tc of msg.tool_calls) {
          if (tc?.type && tc.type !== "function") continue;
          const fnName = sanitizeFunctionName(tc.function?.name);
          const args = safeParseJSON(tc.function?.arguments || "{}", {});
          const cachedSig = getCachedThoughtSignature(tc.id);
          const sig = cachedSig || (!firstSeen ? DEFAULT_THINKING_AG_SIGNATURE : undefined);
          firstSeen = true;
          const emitId = nextUniqueCallId(tc.id);

          const part = {
            functionCall: {
              id: emitId,
              name: fnName,
              args: args && typeof args === "object" ? args : {},
            },
          };
          if (sig) part.thoughtSignature = sig;
          parts.push(part);
          emittedCalls.push({ origId: tc.id, emitId, fnName });
        }

        if (parts.length) rawContents.push({ role: "model", parts });

        const isIntermediate = i < messages.length - 1;
        const hasResp = emittedCalls.some(
          ({ origId }) => (toolCursor[origId] || 0) < (toolResponses[origId]?.length ?? 0)
        );
        if (hasResp || isIntermediate) {
          const respParts = emittedCalls.map(({ origId, emitId, fnName }) => {
            const q = toolResponses[origId];
            const cur = toolCursor[origId] || 0;
            let rawOut = "";
            if (q && cur < q.length) {
              rawOut = q[cur];
              toolCursor[origId] = cur + 1;
            }
            const outStr = typeof rawOut === "string" ? rawOut : extractPlainText(rawOut) || JSON.stringify(rawOut ?? "");
            let parsed = safeParseJSON(outStr, null);
            if (parsed === null || typeof parsed !== "object") {
              parsed = { result: parsed ?? outStr };
            }
            return {
              functionResponse: {
                id: emitId,
                name: fnName,
                response: { result: parsed },
              },
            };
          });
          if (respParts.length) rawContents.push({ role: "user", parts: respParts });
        }
      } else if (parts.length) {
        rawContents.push({ role: "model", parts });
      }
    }
  }

  // Handle JSON response_format instruction gracefully if requested
  if (body.response_format?.type === "json_object") {
    systemTexts.push("IMPORTANT: Respond ONLY with a valid JSON object. Do not wrap in markdown code fences.");
  }

  // Build tools
  let rawTools;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const seenNames = new Set();
    const decls = [];
    for (const t of body.tools) {
      const fn = t?.type === "function" ? t.function : t?.name ? t : null;
      if (!fn?.name) continue;
      const cleanName = sanitizeFunctionName(fn.name);
      if (seenNames.has(cleanName)) continue;
      seenNames.add(cleanName);
      decls.push({
        name: cleanName,
        description: fn.description || "",
        parameters: cleanJSONSchemaForAntigravity(fn.parameters || fn.input_schema || { type: "object", properties: {} }),
      });
    }
    if (decls.length) rawTools = [{ functionDeclarations: decls }];
  }

  const normalizedContents = normalizeGeminiContents(rawContents, cleanModel);
  const { tools: cloakedTools, contents: finalContents, toolNameMap } = cloakToolsAndHistory(
    rawTools,
    normalizedContents
  );

  // GenerationConfig (Gemini 4 drops sampling parameters)
  const generationConfig = {};
  if (!isGemini4Model(cleanModel)) {
    if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
    if (body.top_p !== undefined) generationConfig.topP = body.top_p;
    if (body.top_k !== undefined) generationConfig.topK = body.top_k;
  }
  const maxTok = body.max_completion_tokens ?? body.max_tokens;
  if (maxTok !== undefined && Number.isFinite(Number(maxTok))) {
    generationConfig.maxOutputTokens = Number(maxTok);
  }
  if (Array.isArray(body.stop) && body.stop.length) {
    generationConfig.stopSequences = body.stop.slice(0, 5);
  } else if (typeof body.stop === "string") {
    generationConfig.stopSequences = [body.stop];
  }

  // Thinking configuration
  const clientIntent = extractClientThinkingIntent(body);
  const effectiveThinking = suffixThinking || clientIntent;
  applyAntigravityThinking(generationConfig, cleanModel, effectiveThinking);

  // Output token ceiling (Hydrogen allows up to 1M with longDecode; others cap at 64000)
  const rule = getModelThinkingRule(cleanModel);
  const cap = rule.longDecode ? 1_048_576 : 64_000;
  if (generationConfig.maxOutputTokens > cap) {
    generationConfig.maxOutputTokens = cap;
  }

  // System instruction: apply prompt rewrites & prepend Antigravity identity
  const rewrittenSystemParts = systemTexts
    .map((text) => {
      let out = text;
      for (const { from, to } of ANTIGRAVITY_PROMPT_REWRITES) {
        out = out.replaceAll(from, to);
      }
      return out.trim();
    })
    .filter(Boolean)
    .map((text) => ({ text }));

  const hasAgIdentity = rewrittenSystemParts.some((p) => p.text.includes("You are Antigravity"));
  const systemInstruction = {
    role: "user",
    parts: hasAgIdentity
      ? rewrittenSystemParts
      : [{ text: ANTIGRAVITY_DEFAULT_SYSTEM }, ...rewrittenSystemParts],
  };

  const request = {
    sessionId,
    contents: finalContents,
    systemInstruction,
    generationConfig,
    ...(cloakedTools ? { tools: cloakedTools, toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } } : {}),
  };

  // Official Antigravity client omits `requestType` on chat/agent requests
  const envelope = {
    project: projectId,
    model: cleanModel,
    userAgent: "antigravity",
    requestId: buildIdeRequestId({
      sessionId,
      model: cleanModel,
      contentsCount: finalContents.length,
      requestType: "agent",
    }),
    request,
  };

  return { envelope, toolNameMap };
}

// ─── Prompt-Rejection Helpers (ported from 9router executor) ──────────────────

const BARE_EXHAUSTED_RE = /^Resource has been exhausted \(e\.g\. check quota\)\.?$/;

export function isAntigravityPromptRejection(status, bodyText) {
  if (status !== 429 || !bodyText) return false;
  try {
    const err = JSON.parse(bodyText)?.error;
    if (err?.status !== "RESOURCE_EXHAUSTED") return false;
    if (!BARE_EXHAUSTED_RE.test(String(err.message || "").trim())) return false;
    return !(Array.isArray(err.details) && err.details.length > 0);
  } catch {
    return false;
  }
}

export function moveSystemInstructionToContents(envelope) {
  const { systemInstruction, ...restReq } = envelope?.request || {};
  const parts = (systemInstruction?.parts || []).filter((p) => typeof p?.text === "string" && p.text.trim());
  if (!parts.length) return null;
  const merged = normalizeGeminiContents(
    [{ role: "user", parts }, ...(restReq.contents || [])],
    envelope.model
  );
  return {
    ...envelope,
    request: {
      ...restReq,
      contents: merged,
    },
  };
}

// ─── Antigravity -> OpenAI Response Translators ───────────────────────────────

function mapFinishReason(rawReason, hasToolCalls) {
  if (hasToolCalls) return "tool_calls";
  const r = String(rawReason || "STOP").toUpperCase();
  if (r === "MAX_TOKENS") return "length";
  if (r === "SAFETY" || r === "RECITATION" || r === "BLOCKLIST") return "content_filter";
  return "stop";
}

function mapUsage(usageMeta) {
  if (!usageMeta || typeof usageMeta !== "object") return undefined;
  const prompt = Number(usageMeta.promptTokenCount || 0);
  const thoughts = Number(usageMeta.thoughtsTokenCount || 0);
  const candidates = Number(usageMeta.candidatesTokenCount || 0);
  const total = Number(usageMeta.totalTokenCount || prompt + thoughts + candidates);
  const out = {
    prompt_tokens: prompt,
    completion_tokens: candidates + thoughts,
    total_tokens: total,
  };
  if (thoughts > 0) {
    out.completion_tokens_details = { reasoning_tokens: thoughts };
  }
  return out;
}

function decloakName(rawName, toolNameMap) {
  if (!rawName) return rawName;
  if (toolNameMap?.has(rawName)) return toolNameMap.get(rawName);
  if (rawName.endsWith(AG_TOOL_SUFFIX)) return rawName.slice(0, -AG_TOOL_SUFFIX.length);
  return rawName;
}

export function antigravityToOpenAIJson(rawBody, requestedModel, toolNameMap = null) {
  const response = rawBody?.response || rawBody;
  const candidate = response?.candidates?.[0];
  if (!candidate) {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    };
  }

  let textContent = "";
  let reasoningContent = "";
  const toolCalls = [];
  const images = [];
  let pendingSig = null;

  for (const part of candidate.content?.parts || []) {
    const sig = part.thoughtSignature || part.thought_signature;
    if (typeof sig === "string" && sig) pendingSig = sig;

    if (part.thought === true) {
      if (part.text) reasoningContent += part.text;
    } else if (typeof part.text === "string") {
      textContent += part.text;
    }

    if (part.functionCall) {
      const origName = decloakName(part.functionCall.name, toolNameMap);
      const callId = part.functionCall.id || `call_${origName}_${Date.now()}_${toolCalls.length}`;
      if (sig || pendingSig) {
        storeThoughtSignature(callId, sig || pendingSig);
        pendingSig = null;
      }
      toolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: origName,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }

    const inlineData = part.inlineData || part.inline_data;
    if (inlineData?.data) {
      const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
      const dataUri = `data:${mimeType};base64,${inlineData.data}`;
      images.push({ type: "image_url", image_url: { url: dataUri } });
      textContent += (textContent ? "\n" : "") + `![image](${dataUri})`;
    }
  }

  const message = { role: "assistant", content: textContent || (toolCalls.length ? null : "") };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (images.length) message.images = images;

  const usage = mapUsage(response.usageMetadata || rawBody?.usageMetadata);

  return {
    id: `chatcmpl-${response.responseId || crypto.randomUUID().slice(0, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || response.modelVersion || "antigravity",
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(candidate.finishReason, toolCalls.length > 0),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/**
 * Transform an upstream Antigravity SSE response stream into OpenAI Chat Completions SSE format.
 */
export function createAntigravityToOpenAISSEStream(upstreamBody, requestedModel, toolNameMap = null) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const state = {
    id: null,
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    sentRole: false,
    toolIndex: 0,
    pendingSig: null,
    usage: null,
    sentFinish: false,
  };

  const makeChunk = (delta, finishReason = null, extra = {}) => ({
    id: state.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  });

  const processDataLine = (jsonStr, controller) => {
    let raw;
    try {
      raw = JSON.parse(jsonStr);
    } catch {
      return;
    }
    const response = raw?.response || raw;
    const candidate = response?.candidates?.[0];
    if (!candidate) return;

    if (!state.id) {
      state.id = `chatcmpl-${response.responseId || crypto.randomUUID().slice(0, 12)}`;
    }
    if (!state.sentRole) {
      state.sentRole = true;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk({ role: "assistant" }))}\n\n`));
    }

    for (const part of candidate.content?.parts || []) {
      const sig = part.thoughtSignature || part.thought_signature;
      if (typeof sig === "string" && sig) state.pendingSig = sig;

      if (part.thought === true) {
        if (part.text) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(makeChunk({ reasoning_content: part.text }))}\n\n`)
          );
        }
      } else if (typeof part.text === "string" && part.text !== "") {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk({ content: part.text }))}\n\n`));
      }

      if (part.functionCall) {
        const origName = decloakName(part.functionCall.name, toolNameMap);
        const idx = state.toolIndex++;
        const callId = part.functionCall.id || `call_${origName}_${Date.now()}_${idx}`;
        if (sig || state.pendingSig) {
          storeThoughtSignature(callId, sig || state.pendingSig);
          state.pendingSig = null;
        }
        const tc = {
          index: idx,
          id: callId,
          type: "function",
          function: {
            name: origName,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk({ tool_calls: [tc] }))}\n\n`));
      }

      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) {
        const mime = inlineData.mimeType || inlineData.mime_type || "image/png";
        const md = `\n![image](data:${mime};base64,${inlineData.data})\n`;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeChunk({ content: md }))}\n\n`));
      }
    }

    const usage = mapUsage(response.usageMetadata || raw?.usageMetadata);
    if (usage) state.usage = usage;

    if (candidate.finishReason && candidate.finishReason !== "CONTINUATION") {
      state.sentFinish = true;
      const finishReason = mapFinishReason(candidate.finishReason, state.toolIndex > 0);
      const finalChunk = makeChunk({}, finishReason, state.usage ? { usage: state.usage } : {});
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
    }
  };

  let buffer = "";
  const reader = upstreamBody.getReader();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            for (const line of buffer.split("\n")) {
              const trimmed = line.trim();
              if (trimmed.startsWith("data:")) {
                const payload = trimmed.slice(5).trim();
                if (payload && payload !== "[DONE]") processDataLine(payload, controller);
              }
            }
          }
          if (!state.sentFinish && state.sentRole) {
            const finishReason = state.toolIndex > 0 ? "tool_calls" : "stop";
            const finalChunk = makeChunk({}, finishReason, state.usage ? { usage: state.usage } : {});
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          processDataLine(payload, controller);
        }
      } catch (err) {
        const errFrame = {
          error: { message: err?.message || "Upstream stream interrupted", type: "upstream_stream_error" },
        };
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errFrame)}\n\ndata: [DONE]\n\n`));
        } catch {}
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}
