import { describe, expect, it } from "vitest";
import { isIdentityId, localIdentity, resolveManifest, unboundServices } from "./identity.js";

describe("resolveManifest", () => {
  it("overrides a stated id", () => {
    const stated = { importName: "a", api: 2, id: "evil" };
    const resolved = resolveManifest(stated, { id: "github:1", name: "repo" });
    expect(resolved.id).toBe("github:1");
    expect(resolved.name).toBe("repo");
    expect(resolved.importName).toBe("a");
  });
});

describe("localIdentity", () => {
  it("names the import", () => {
    expect(localIdentity("calendar")).toEqual({ id: "local:calendar", name: "calendar" });
  });
});

describe("isIdentityId", () => {
  it("accepts local and forge ids", () => {
    expect(isIdentityId("local:calendar")).toBe(true);
    expect(isIdentityId("github:123")).toBe(true);
    expect(isIdentityId("gitea@git.example.com:12/runtime")).toBe(true);
  });

  it("refuses a bare name, an empty id and an uppercase forge", () => {
    expect(isIdentityId("calendar")).toBe(false);
    expect(isIdentityId("github:")).toBe(false);
    expect(isIdentityId("GitHub:1")).toBe(false);
  });
});

describe("unboundServices", () => {
  it("skips bare ids and ids bound by a provider", () => {
    const services = { consumes: ["clock", "calendar:events", { id: "mail:send", provider: "github:2" }, { id: "mail:read" }] };
    expect(unboundServices({ services })).toEqual(["calendar:events", "mail:read"]);
  });

  it("is empty for a manifest with no services", () => {
    expect(unboundServices({})).toEqual([]);
  });
});
