import assert from "node:assert/strict";
import test from "node:test";

import {
  isV4GameJsonRequest,
  rebaseV4GameJson
} from "../src/game-json.js";

const PREFIX = "/bucket/releases/v5/";

test("V4 catalog rebasing changes only each entry's immediate url", () => {
  const input = JSON.stringify([
    {
      url: "./filestorage/gd/minecraft/index.html?mode=full#game",
      img: "./filestorage/photos/minecraft.png",
      legacyId: "/minecraft",
      metadata: { url: "/must-stay-logical" }
    },
    { url: "/filestorage/gn/338.html", legacyId: "files" },
    { url: "https://games.example/play", legacyId: "external" },
    { name: "No URL" }
  ]);

  assert.deepEqual(
    JSON.parse(rebaseV4GameJson(input, "GET", "/gxxes.json", PREFIX)),
    [
      {
        url: "/bucket/releases/v5/filestorage/gd/minecraft/index.html?mode=full#game",
        img: "./filestorage/photos/minecraft.png",
        legacyId: "/minecraft",
        metadata: { url: "/must-stay-logical" }
      },
      {
        url: "/bucket/releases/v5/filestorage/gn/338.html",
        legacyId: "files"
      },
      { url: "https://games.example/play", legacyId: "external" },
      { name: "No URL" }
    ]
  );
});

test("V4 game detail rebasing changes only the top-level url", () => {
  const input = JSON.stringify({
    name: "Minecraft",
    url: "./filestorage/gd/minecraft/index.html",
    legacyId: "/leave-this-alone",
    saves: [{ key_name: "state", value: { url: "/saved-value" } }]
  });

  assert.deepEqual(
    JSON.parse(rebaseV4GameJson(input, "GET", "/apiv2/gxxe/0", PREFIX)),
    {
      name: "Minecraft",
      url: "/bucket/releases/v5/filestorage/gd/minecraft/index.html",
      legacyId: "/leave-this-alone",
      saves: [{ key_name: "state", value: { url: "/saved-value" } }]
    }
  );
});

test("logical game paths are still prefixed when they collide with the bucket name", () => {
  const filestorage = JSON.stringify({ url: "/filestorage/gn/752.html" });
  assert.deepEqual(
    JSON.parse(rebaseV4GameJson(filestorage, "GET", "/apiv2/gxxe/1320", "/filestorage/")),
    { url: "/filestorage/filestorage/gn/752.html" }
  );

  const pubup = JSON.stringify([{ url: "/pubup/index.html?https://games.example/" }]);
  assert.deepEqual(
    JSON.parse(rebaseV4GameJson(pubup, "GET", "/gxxes.json", "/pubup/")),
    [{ url: "/pubup/pubup/index.html?https://games.example/" }]
  );
});

test("root deployments and unrelated JSON are returned byte-for-byte", () => {
  const input = '{ "url": "./filestorage/gd/minecraft/index.html" }';
  assert.equal(rebaseV4GameJson(input, "GET", "/apiv2/gxxe/0", "/"), input);
  assert.equal(rebaseV4GameJson(input, "POST", "/apiv2/gxxe/0", PREFIX), input);
  assert.equal(rebaseV4GameJson(input, "GET", "/apiv2/gxxes", PREFIX), input);
  assert.equal(rebaseV4GameJson(input, "GET", "/other.json", PREFIX), input);
  assert.equal(rebaseV4GameJson("not-json", "GET", "/gxxes.json", PREFIX), "not-json");
});

test("only exact deployed V4 request paths are selected", () => {
  assert.equal(isV4GameJsonRequest("GET", "/gxxes.json"), true);
  assert.equal(isV4GameJsonRequest("GET", "/apiv2/gxxe/minecraft"), true);
  assert.equal(isV4GameJsonRequest("GET", "/apiv2/gxxe/delete/minecraft"), false);
  assert.equal(isV4GameJsonRequest("GET", "/apiv2/gxxe/"), false);
  assert.equal(isV4GameJsonRequest("POST", "/apiv2/gxxe/minecraft"), false);
});
