"use strict";

const { describe, it, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadMain, fakePi } = require("./helpers");

const loaded = [];
after(async () => { for (const m of loaded) await m.onUnload().catch(() => {}); });

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PNG_DATA = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const WEBP_DATA = "data:image/webp;base64,UklGRhIAAABXRUJQVlA4";
const keyOf = (image) => crypto.createHash("sha256").update(image).digest("hex").slice(0, 16);

let tmp, dataDir, realFetch, fetched;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "radar-avatar-"));
  dataDir = path.join(tmp, "data");
  fs.mkdirSync(dataDir);
  realFetch = globalThis.fetch;
  fetched = [];
  globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error("no network in tests"); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A loaded plugin with its data folder in `dataDir`. */
async function fresh(settings = {}) {
  const pi = fakePi({ settings });
  pi.plugin.getDataPath = async () => dataDir;
  const main = loadMain(pi);
  loaded.push(main);
  await main.onLoad();
  return { main, pi };
}

const me = async (main) => main.onPanelInvoke("radar.me", {});
const setMe = async (main, image) => main.onPanelInvoke("radar.setMe", { image });
const stateKey = async (main) => (await main.onPanelInvoke("radar.state", {})).me;
const cache = () => path.join(dataDir, "avatar.json");

describe("your picture in the centre", () => {
  it("has no picture and no file by default; the state carries only the key", async () => {
    const { main } = await fresh();
    assert.deepEqual(await me(main), { ok: true, image: "", key: "" });
    assert.deepEqual(await stateKey(main), { key: "" });
    assert.equal(fs.existsSync(cache()), false);
  });

  it("saves a picked picture in the data folder; a restart loads it from there", async () => {
    const { main } = await fresh();
    assert.deepEqual(await setMe(main, PNG_DATA), { ok: true, key: keyOf(PNG_DATA) });
    assert.deepEqual(await me(main), { ok: true, image: PNG_DATA, key: keyOf(PNG_DATA) });
    assert.deepEqual(await stateKey(main), { key: keyOf(PNG_DATA) }); // the picture itself is not in the state
    assert.equal(JSON.parse(fs.readFileSync(cache(), "utf8")).image, PNG_DATA);

    const again = await fresh();
    assert.equal((await me(again.main)).image, PNG_DATA);
  });

  it("a new picture replaces the old one", async () => {
    const { main } = await fresh();
    await setMe(main, PNG_DATA);
    await setMe(main, WEBP_DATA);
    assert.equal((await me(main)).image, WEBP_DATA);
    assert.equal(JSON.parse(fs.readFileSync(cache(), "utf8")).image, WEBP_DATA);
  });

  it("removing the picture deletes its file", async () => {
    const { main } = await fresh();
    await setMe(main, PNG_DATA);
    assert.deepEqual(await setMe(main, ""), { ok: true, key: "" });
    assert.deepEqual(await me(main), { ok: true, image: "", key: "" });
    assert.equal(fs.existsSync(cache()), false);
  });

  it("refuses anything but a PNG, JPEG, GIF or WebP data URL up to 2 MB, and keeps the current picture", async () => {
    const { main } = await fresh();
    await setMe(main, PNG_DATA);
    for (const bad of [
      "/Users/me/me.png",
      "https://example.com/me.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:text/html;base64,PGI+",
      "data:image/png;base64,not base64!",
      `data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}`,
    ]) {
      const r = await setMe(main, bad);
      assert.equal(r.ok, false, bad.slice(0, 40));
      assert.equal((await me(main)).image, PNG_DATA, bad.slice(0, 40));
    }
  });

  it("ignores the old picture settings and never uses the network", async () => {
    const file = path.join(tmp, "me.png");
    fs.writeFileSync(file, PNG_BYTES);
    const { main } = await fresh({ avatarImage: file, gravatarEmail: "me@example.com" });
    assert.deepEqual(await me(main), { ok: true, image: "", key: "" });
    assert.deepEqual(fetched, []);
  });

  it("keeps a picture cached by 0.34 (with its source) and drops a broken file", async () => {
    fs.writeFileSync(cache(), JSON.stringify({ source: "https://example.com/me.png", image: PNG_DATA }));
    assert.equal((await me((await fresh()).main)).image, PNG_DATA);
    fs.writeFileSync(cache(), "{ not json");
    assert.deepEqual(await me((await fresh()).main), { ok: true, image: "", key: "" });
    fs.writeFileSync(cache(), JSON.stringify({ image: "data:text/html;base64,PGI+" }));
    assert.equal((await me((await fresh()).main)).image, "");
  });

  it("works without a data folder: the picture lasts until the plugin reloads", async () => {
    const pi = fakePi();
    pi.plugin.getDataPath = async () => "";
    const main = loadMain(pi);
    loaded.push(main);
    await main.onLoad();
    assert.equal((await setMe(main, PNG_DATA)).ok, true);
    assert.equal((await me(main)).image, PNG_DATA);
  });
});

describe("reload after an update", () => {
  it("the state carries the manifest version, so an open view can see that main.js changed", async () => {
    const { main } = await fresh();
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
    assert.ok(version);
    assert.equal((await main.onPanelInvoke("radar.state", {})).version, version);
  });
});
