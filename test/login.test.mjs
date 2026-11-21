import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMethods } from "../src/login.mjs";

const KEY = "fake-deepai-key-0001";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("createMethods：三路（浏览器推荐在前）", () => {
  const methods = createMethods({ options: { lang: "zh" }, deps: { fetchImpl: async () => json({}) } });
  assert.equal(methods.length, 3);
  assert.deepEqual(methods.map((m) => m.type), ["api", "api", "api"]);
  assert.match(methods[0].label, /推荐/);
  const prompts = methods[0].prompts ?? [];
  assert.deepEqual(prompts.map((p) => p.key), ["login_url", "code"]);
  const urlPrompt = prompts[0];
  const urlText = [
    urlPrompt.message,
    urlPrompt.description,
    urlPrompt.placeholder,
    urlPrompt.default,
    urlPrompt.initial,
    urlPrompt.value,
    urlPrompt.initialValue,
    urlPrompt.defaultValue,
    urlPrompt.prefill,
    urlPrompt.content,
    urlPrompt.text,
  ]
    .filter(Boolean)
    .join("\n");
  assert.match(urlText, /\/deepai_code\/desktop_auth\//);
  assert.match(methods[1].label, /凭据/);
  assert.match(methods[2].label, /Key/);
});

test("桌面端登录：读文件 + /theos 验活", async () => {
  const base = mkdtempSync(join(tmpdir(), "deepaicode-login-"));
  mkdirSync(join(base, "userdata", "secrets"), { recursive: true });
  writeFileSync(
    join(base, "userdata", "secrets", "deepai-account.bin"),
    JSON.stringify({ apiKey: KEY, username: "ada", isPro: false }),
    "utf8",
  );

  const old = process.env.T3CODE_HOME;
  process.env.T3CODE_HOME = base;
  try {
    const fetchImpl = async (url) => {
      if (url.endsWith("/theos")) return json({ enabled: true, balance: "200.00000", granted: "200.00000" });
      throw new Error(`unexpected ${url}`);
    };
    const methods = createMethods({ options: { lang: "zh", laneVersion: "4" }, deps: { fetchImpl } });
    const out = await methods[1].authorize({ dir: "", key: "", keyInputs: "" });
    assert.equal(out.type, "success");
    assert.equal(out.key, KEY);
    assert.equal(out.metadata.mode, "direct");
    assert.equal(out.metadata.source, "desktop");
    assert.equal(out.metadata.username, "ada");
    assert.equal(out.metadata.machineId, undefined, "不应保存每账号派生的机器标识");
    assert.match(out.accountId, /^deepai:/);
  } finally {
    if (old === undefined) delete process.env.T3CODE_HOME;
    else process.env.T3CODE_HOME = old;
    rmSync(base, { recursive: true, force: true });
  }
});

test("桌面端登录：找不到凭据时列出尝试过的路径", async () => {
  const methods = createMethods({
    options: { lang: "zh", secretDir: "C:\\definitely-missing" },
    deps: { fetchImpl: async () => json({}) },
  });
  const out = await methods[1].authorize({ dir: "C:\\definitely-missing" });
  assert.equal(out.type, "failed");
  assert.match(out.error, /没有找到桌面端凭据/);
});

test("粘贴登录：缺 Key 失败；有 Key 成功", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/theos")) return json({ enabled: true, balance: "200", granted: "200" });
    throw new Error(`unexpected ${url}`);
  };
  const methods = createMethods({ options: { lang: "zh", laneVersion: "4" }, deps: { fetchImpl } });

  const missing = await methods[2].authorize({});
  assert.equal(missing.type, "failed");
  assert.match(missing.error, /缺少 DeepAI API Key/);

  const ok = await methods[2].authorize({ key: KEY, username: "ada" });
  assert.equal(ok.type, "success");
  assert.equal(ok.key, KEY);
  assert.equal(ok.metadata.username, "ada");
});

test("debug 日志只记字段名，绝不记录 Key 值", async () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    const fetchImpl = async (url) => {
      if (url.endsWith("/theos")) return json({ enabled: true, balance: "200", granted: "200" });
      throw new Error(`unexpected ${url}`);
    };
    const methods = createMethods({
      options: { lang: "zh", debug: true, laneVersion: "4" },
      deps: { fetchImpl },
    });
    await methods[2].authorize({ key: KEY, username: "ada" });
  } finally {
    console.error = original;
  }

  const all = lines.join("\n");
  assert.match(all, /fields present: .*key/);
  assert.ok(!all.includes(KEY), "日志不得包含 Key 明文");
});

test("浏览器登录：显示可复制登录链接（不自动打开），粘贴 code 换 Key", async () => {
  let called = 0;
  const fetchImpl = async (url, init) => {
    called += 1;
    assert.match(url, /\/deepai_code\/desktop_auth\/exchange\/$/);
    assert.deepEqual(JSON.parse(init.body), { code: "the-code" });
    return json({ api_key: KEY, username: "ada", is_pro: false });
  };
  const methods = createMethods({ options: { lang: "zh" }, deps: { fetchImpl } });
  const method = methods[0];

  assert.equal(method.type, "api");
  const prompts = method.prompts ?? [];
  assert.deepEqual(prompts.map((p) => p.key), ["login_url", "code"]);
  const urlPrompt = prompts[0];
  const urlText = [
    urlPrompt.message,
    urlPrompt.description,
    urlPrompt.placeholder,
    urlPrompt.default,
    urlPrompt.initial,
    urlPrompt.value,
    urlPrompt.initialValue,
    urlPrompt.defaultValue,
    urlPrompt.prefill,
    urlPrompt.content,
    urlPrompt.text,
  ]
    .filter(Boolean)
    .join("\n");
  const match = String(urlText).match(/https?:\/\/\S+/);
  assert.ok(match, "应提供登录链接");
  const loginUrl = new URL(match[0]);
  assert.equal(loginUrl.pathname, "/deepai_code/desktop_auth/");
  assert.ok(loginUrl.searchParams.get("state")?.length >= 16);
  assert.equal(loginUrl.searchParams.get("port"), "0");

  const out = await method.authorize({ login_url: loginUrl.toString(), code: "the-code" });
  assert.equal(out.type, "success");
  assert.equal(out.key, KEY);
  assert.equal(out.metadata.source, "browser");
  assert.equal(called, 1);
});

test("浏览器登录：粘贴完整回调 URL 时自动提取 code", async () => {
  let called = 0;
  const fetchImpl = async (url, init) => {
    called += 1;
    assert.deepEqual(JSON.parse(init.body), { code: "the-code" });
    return json({ api_key: KEY, username: "ada", is_pro: false });
  };
  const methods = createMethods({ options: { lang: "zh" }, deps: { fetchImpl } });
  const out = await methods[0].authorize({
    code: "http://127.0.0.1:12345/auth-callback?code=the-code&state=xyz",
  });
  assert.equal(out.type, "success");
  assert.equal(out.key, KEY);
  assert.equal(called, 1);
});

test("浏览器登录：空 code 返回 failed 且不请求上游", async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return json({});
  };
  const methods = createMethods({ options: { lang: "zh" }, deps: { fetchImpl } });
  const urlPrompt = methods[0].prompts.find((p) => p.key === "login_url");
  const loginUrl = String(
    urlPrompt?.default || urlPrompt?.value || urlPrompt?.initialValue || "",
  );

  const empty = await methods[0].authorize({ code: "   " });
  assert.equal(empty.type, "failed");
  assert.match(empty.error, /缺少登录 code|Login code is missing/);
  assert.equal(called, 0);

  const unchanged = await methods[0].authorize({ code: loginUrl });
  assert.equal(unchanged.type, "failed");
  assert.match(unchanged.error, /缺少登录 code|Login code is missing/);
  assert.equal(called, 0);
});
