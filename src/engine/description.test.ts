import { describe, expect, it } from "vitest";
import { descriptionIssues } from "./description.js";
import { validateManifest } from "./validation.js";

const call = { service: "demo:screens", method: "refresh" };

function manifestWith(extra: Record<string, unknown>): Record<string, unknown> {
  return { id: "demo", api: 2, services: { provides: ["demo:screens"] }, ...extra };
}

function viewOf(...nodes: Record<string, unknown>[]): Record<string, unknown> {
  return { views: { main: { title: "Main", nodes } } };
}

function pathsOf(manifest: unknown): string[] {
  return validateManifest(manifest, []).map((issue) => issue.path);
}

describe("descriptionIssues", () => {
  it("accepts a description whose references all resolve", () => {
    const manifest = manifestWith({
      settings: { retryLimit: { type: "number", label: "Retries" } },
      actions: { refresh: { label: "Refresh", call } },
      ...viewOf(
        { id: "root", component: "stack" },
        { id: "go", parent: "root", component: "button", action: "refresh", bind: call },
        { id: "limit", parent: "root", component: "field", field: "retryLimit" },
      ),
    });
    expect(descriptionIssues(manifest)).toEqual([]);
    expect(validateManifest(manifest, [])).toEqual([]);
  });

  it("reports each repeat of a node id at its own path", () => {
    const manifest = manifestWith(
      viewOf({ id: "a", component: "stack" }, { id: "a", component: "text" }, { id: "a", component: "text" }),
    );
    expect(descriptionIssues(manifest)).toMatchObject([
      { path: "views.main.nodes[1].id", fix: "give each node in a view its own id" },
      { path: "views.main.nodes[2].id", fix: "give each node in a view its own id" },
    ]);
  });

  it("refuses a node that is its own parent", () => {
    const manifest = manifestWith(viewOf({ id: "a", parent: "a", component: "stack" }));
    expect(descriptionIssues(manifest)).toMatchObject([
      { path: "views.main.nodes[0].parent", fix: "name the id of a node listed before this one" },
    ]);
  });

  it("refuses a parent listed after its child", () => {
    const manifest = manifestWith(viewOf({ id: "a", parent: "b", component: "stack" }, { id: "b", component: "stack" }));
    expect(pathsOf(manifest)).toEqual(["views.main.nodes[0].parent"]);
  });

  it("resolves a parent on any earlier node carrying that id", () => {
    const manifest = manifestWith(
      viewOf({ id: "a", component: "stack" }, { id: "a", component: "stack" }, { id: "c", parent: "a", component: "text" }),
    );
    expect(pathsOf(manifest)).toEqual(["views.main.nodes[1].id"]);
  });

  it("refuses an unknown action with the fix", () => {
    const manifest = manifestWith(viewOf({ id: "a", component: "button", action: "missing" }));
    expect(descriptionIssues(manifest)).toMatchObject([
      { path: "views.main.nodes[0].action", fix: "name one of this manifest's actions" },
    ]);
  });

  it("refuses a field with no settings and does not throw", () => {
    const manifest = manifestWith(viewOf({ id: "a", component: "field", field: "retryLimit" }));
    expect(descriptionIssues(manifest)).toMatchObject([
      { path: "views.main.nodes[0].field", fix: "name one of this manifest's settings" },
    ]);
  });

  it("refuses a binding to a service the plugin does not provide, in an action and a node", () => {
    const manifest = {
      id: "demo",
      api: 2,
      services: { consumes: ["demo:other"] },
      actions: { refresh: { label: "Refresh", call: { service: "demo:other", method: "refresh" } } },
      ...viewOf({ id: "a", component: "list", bind: { service: "demo:other", method: "read" } }),
    };
    expect(descriptionIssues(manifest)).toMatchObject([
      { path: "actions.refresh.call.service", fix: "bind to a service this plugin provides" },
      { path: "views.main.nodes[0].bind.service", fix: "bind to a service this plugin provides" },
    ]);
  });

  it("counts a provided service written in its object form", () => {
    const manifest = {
      id: "demo",
      api: 2,
      services: { provides: [{ id: "demo:screens" }] },
      actions: { refresh: { label: "Refresh", call } },
    };
    expect(descriptionIssues(manifest)).toEqual([]);
  });

  it("orders actions first, then views by key, nodes by index, and within a node id, parent, action, field, bind", () => {
    const stranger = { service: "x:y", method: "m" };
    const manifest = manifestWith({
      actions: { zeta: { label: "Z", call: stranger } },
      views: {
        second: { title: "S", nodes: [{ id: "n", component: "text", action: "q" }] },
        first: {
          title: "F",
          nodes: [
            { id: "a", component: "stack" },
            { id: "a", parent: "nope", component: "field", action: "q", field: "f", bind: stranger },
          ],
        },
      },
    });
    expect(pathsOf(manifest)).toEqual([
      "actions.zeta.call.service",
      "views.second.nodes[0].action",
      "views.first.nodes[1].id",
      "views.first.nodes[1].parent",
      "views.first.nodes[1].action",
      "views.first.nodes[1].field",
      "views.first.nodes[1].bind.service",
    ]);
  });

  it("refuses a choice setting with no choices", () => {
    const manifest = manifestWith({ settings: { mode: { type: "choice", label: "Mode", choices: [] } } });
    expect(validateManifest(manifest, [])).not.toEqual([]);
  });
});
