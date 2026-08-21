// Functional verification of deployed YuriRTC signaling security rules.
// Reading the rules back only proves they uploaded; this proves they behave.

const API_KEY = process.env.YURIRTC_FIREBASE_API_KEY ?? process.env.FB_API_KEY;
const DB = process.env.YURIRTC_FIREBASE_DATABASE_URL ?? process.env.FB_DB_URL;
const PROJECT = process.env.YURIRTC_FIREBASE_PROJECT_ID ?? process.env.FB_PROJECT;

if (!API_KEY || !DB || !PROJECT) {
  throw new Error("set YURIRTC_FIREBASE_API_KEY, YURIRTC_FIREBASE_DATABASE_URL, and YURIRTC_FIREBASE_PROJECT_ID");
}

let pass = 0, fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// --- anonymous sign-in (RTDB leg only) -------------------------------------
const signIn = async () => {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }) }
  );
  if (!r.ok) throw new Error(`sign-in ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

let a, b;
try {
  a = await signIn();
  b = await signIn();
  check(!!a.idToken && !!a.localId, "anonymous sign-in enabled");
} catch (e) {
  check(false, "anonymous sign-in enabled", e.message);
  process.exit(1);
}

const offer = JSON.stringify({ sessionId: "verify-" + Date.now(), sdp: "v=0\r\n", candidates: [] });

// --- RTDB: per-uid isolation -----------------------------------------------
const rtdb = (path, token, init = {}) =>
  fetch(`${DB}/${path}.json?auth=${encodeURIComponent(token)}`, init);

check(
  (await rtdb(`signal/${a.localId}/offer`, a.idToken, { method: "PUT", body: offer })).ok,
  "RTDB: client can write its own offer"
);

check(
  !(await rtdb(`signal/${b.localId}/offer`, a.idToken, { method: "PUT", body: offer })).ok,
  "RTDB: client CANNOT write another client's branch"
);

check(
  !(await rtdb(`signal/${b.localId}`, a.idToken)).ok,
  "RTDB: client CANNOT read another client's offer (SDP carries local IPs)"
);

check(!(await rtdb("signal", a.idToken)).ok, "RTDB: tree root is not enumerable");

check(
  !(await rtdb(`signal/${a.localId}/answer`, a.idToken, { method: "PUT", body: '{"sdp":"forged"}' })).ok,
  "RTDB: client CANNOT forge an answer"
);

check(
  !(await rtdb(`signal/${a.localId}/offer`, a.idToken, {
    method: "PUT",
    body: JSON.stringify({ sessionId: "abuse", sdp: "v=0", candidates: "x".repeat(20000) })
  })).ok,
  "RTDB: malformed/oversize candidates are rejected"
);

check(
  !(await rtdb(`signal/${a.localId}/offer`, a.idToken, {
    method: "PUT",
    body: JSON.stringify({ sessionId: "abuse", sdp: "v=0", unexpected: "x" })
  })).ok,
  "RTDB: unexpected offer fields are rejected"
);

// --- Firestore: capability model, no auth ----------------------------------
const cap = [...crypto.getRandomValues(new Uint8Array(16))]
  .map((x) => x.toString(16).padStart(2, "0")).join("");
const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/signal`;
const doc = {
  fields: {
    offer: { stringValue: offer },
    expireAt: { timestampValue: new Date(Date.now() + 300e3).toISOString() }
  }
};

// Unauthenticated on purpose: the capability id is the authorisation.
check(
  (await fetch(`${base}/${cap}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(doc)
  })).ok,
  "Firestore: anonymous client can create by capability id"
);

// The live node can consume and delete the deliberately fake SDP between the
// create above and this read. A missing, never-created capability is a stable
// rules probe: `allow get` returns 404, while a denied get returns 403.
const getById = await fetch(`${base}/${cap}missing?mask.fieldPaths=answer`);
check(
  getById.status === 404,
  "Firestore: get by id is allowed (missing document returns 404)",
  `status ${getById.status}`
);

const list = await fetch(base);
check(!list.ok, "Firestore: collection is NOT listable (allow list: false)", `status ${list.status}`);

check(
  !(await fetch(`${base}/${cap}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: { answer: { stringValue: "forged" } } })
  })).ok,
  "Firestore: client CANNOT write an answer (allow update: false)"
);

check(!(await fetch(`${base}/${cap}`, { method: "DELETE" })).ok, "Firestore: client CANNOT delete");

const oversize = await fetch(`${base}/${cap}x`, {
  method: "PATCH", headers: { "content-type": "application/json" },
  body: JSON.stringify({ fields: { offer: { stringValue: "x".repeat(20000) },
    expireAt: { timestampValue: new Date(Date.now() + 300e3).toISOString() } } })
});
check(!oversize.ok, "Firestore: oversize offer rejected by the size guard");

const extraField = await fetch(`${base}/${cap}y`, {
  method: "PATCH", headers: { "content-type": "application/json" },
  body: JSON.stringify({ fields: { offer: { stringValue: offer },
    expireAt: { timestampValue: new Date(Date.now() + 300e3).toISOString() },
    evil: { stringValue: "x" } } })
});
check(!extraField.ok, "Firestore: unexpected fields rejected by hasOnly()");

for (const [suffix, expires, label] of [
  ["past", Date.now() - 60e3, "past expiry"],
  ["far", Date.now() + 60 * 60e3, "far-future expiry"]
]) {
  const invalidExpiry = await fetch(`${base}/${cap}${suffix}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: { offer: { stringValue: offer },
      expireAt: { timestampValue: new Date(expires).toISOString() } } })
  });
  check(!invalidExpiry.ok, `Firestore: ${label} rejected`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
