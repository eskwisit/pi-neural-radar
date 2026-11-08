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
const keyOf = (image) => crypto.createHash("sha256").update(image).digest("hex").slice(0, 16);

let tmp, dataDir, realFetch, fetched;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "radar-avatar-"));
  dataDir = path.join(tmp, "data");
  fs.mkdirSync(dataDir);
  realFetch = globalThis.fetch;
  fetched = [];
  // a fake network: Gravatar of me@example.com and one https picture exist, everything else 404s
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    const ok = /example\.com\/me\.png$/.test(url) || url.includes(sha("me@example.com"));
    return {
      ok,
      status: ok ? 200 : 404,
      headers: { get: (h) => (h.toLowerCase() === "content-type" && ok ? "image/png" : "") },
      arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.length),
    };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** A loaded plugin whose settings live in `settings`; settingsChanged is fired by `change`. */
async function fresh(settings = {}) {
  const pi = fakePi({ settings });
  pi.plugin.getDataPath = async () => dataDir;
  const main = loadMain(pi);
  loaded.push(main);
  await main.onLoad();
  const change = async (patch) => {
    Object.assign(settings, patch);
    for (const [name, fn] of pi.on) if (name === "plugin:settingsChanged") fn();
    await new Promise((r) => setTimeout(r, 0)); // readSettings awaits getSettings first
  };
  return { main, pi, settings, change };
}

const me = async (main) => main.onPanelInvoke("radar.me", {});
const stateKey = async (main) => (await main.onPanelInvoke("radar.state", {})).me;
const cache = () => path.join(dataDir, "avatar.json");

describe("your picture in the centre", () => {
  it("has no picture and no cache by default; the state carries only the key", async () => {
    const { main } = await fresh();
    assert.deepEqual(await me(main), { ok: true, image: "", key: "" });
    assert.deepEqual(await stateKey(main), { key: "" });
    assert.equal(fs.existsSync(cache()), false);
  });

  it("reads an image file from its full path once and caches it with its source", async () => {
    const file = path.join(tmp, "me.png");
    fs.writeFileSync(file, PNG_BYTES);
    const { main } = await fresh({ avatarImage: file });
    assert.deepEqual(await me(main), { ok: true, image: PNG_DATA, key: keyOf(PNG_DATA) });
    assert.deepEqual(await stateKey(main), { key: keyOf(PNG_DATA) }); // the picture itself is not in the state
    const saved = JSON.parse(fs.readFileSync(cache(), "utf8"));
    assert.deepEqual([saved.source, saved.image], [file, PNG_DATA]);

    // a new start uses the cache: the file is no longer needed
    fs.rmSync(file);
    const again = await fresh({ avatarImage: file });
    assert.equal((await me(again.main)).image, PNG_DATA);
  });

  it("downloads an https picture once; a restart takes it from the cache", async () => {
    const url = "https://example.com/me.png";
    const { main } = await fresh({ avatarImage: url });
    assert.equal((await me(main)).image, PNG_DATA);
    const again = await fresh({ avatarImage: url });
    assert.equal((await me(again.main)).image, PNG_DATA);
    assert.deepEqual(fetched, [url]);
  });

  it("uses the Gravatar (SHA-256 of the trimmed, lower-case address) when no image is set", async () => {
    const { main } = await fresh({ gravatarEmail: "  Me@Example.COM " });
    assert.equal((await me(main)).image, PNG_DATA);
    assert.deepEqual(fetched, [`https://gravatar.com/avatar/${sha("me@example.com")}?s=112&d=404`]);
  });

  it("the image setting wins over the Gravatar email", async () => {
    const { main } = await fresh({ avatarImage: "https://example.com/me.png", gravatarEmail: "me@example.com" });
    assert.equal((await me(main)).image, PNG_DATA);
    assert.deepEqual(fetched, ["https://example.com/me.png"]);
  });

  it("clearing the settings removes the picture and its cache", async () => {
    const { main, change } = await fresh({ avatarImage: "https://example.com/me.png" });
    assert.equal((await me(main)).image, PNG_DATA);
    assert.equal(fs.existsSync(cache()), true);
    await change({ avatarImage: "" });
    assert.deepEqual(await me(main), { ok: true, image: "", key: "" });
    assert.equal(fs.existsSync(cache()), false);
  });

  it("a changed source replaces the cached picture", async () => {
    const file = path.join(tmp, "other.png");
    fs.writeFileSync(file, Buffer.concat([PNG_BYTES, Buffer.from("x")]));
    const { main, change } = await fresh({ avatarImage: "https://example.com/me.png" });
    await me(main);
    await change({ avatarImage: file });
    const r = await me(main);
    assert.notEqual(r.image, PNG_DATA);
    assert.equal(JSON.parse(fs.readFileSync(cache(), "utf8")).source, file);
  });

  it("shows no picture (and keeps no cache) for a relative path, an unknown type, a missing file, a 404 or a bad email", async () => {
    const txt = path.join(tmp, "me.txt");
    fs.writeFileSync(txt, "hello");
    for (const settings of [
      { avatarImage: "me.png" },
      { avatarImage: txt },
      { avatarImage: path.join(tmp, "missing.png") },
      { avatarImage: "https://example.com/nope.png" },
      { gravatarEmail: "nobody@example.com" },
      { gravatarEmail: "not an email" },
    ]) {
      const { main } = await fresh(settings);
      assert.deepEqual(await me(main), { ok: true, image: "", key: "" }, JSON.stringify(settings));
      assert.equal(fs.existsSync(cache()), false, JSON.stringify(settings));
    }
  });

  it("refuses an image file larger than 2 MB", async () => {
    const big = path.join(tmp, "big.png");
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1));
    const { main } = await fresh({ avatarImage: big });
    assert.equal((await me(main)).image, "");
  });
});
