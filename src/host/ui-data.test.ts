import { describe, expect, it } from "vitest";
import { checkUiData } from "./ui-data.js";

function pathsOf(component: Parameters<typeof checkUiData>[0], value: unknown): string[] {
  return (checkUiData(component, value) ?? []).map((issue) => issue.path);
}

describe("checkUiData", () => {
  it("accepts an items answer and names the failing item", () => {
    expect(checkUiData("list", { items: [{ id: "a", label: "A", state: "installed", values: { size: 3 } }] })).toEqual([]);
    expect(pathsOf("table", { items: [{ id: "a" }, { label: "no id" }] })).toEqual(["items[1].id"]);
    expect(pathsOf("tree", { items: [{ id: "a", state: "gone" }] })).toEqual(["items[0].state"]);
    expect(pathsOf("list", { items: [{ id: "a", tone: "#ff0000" }] })).toEqual(["items[0].tone"]);
  });

  it("accepts a text answer for each text component", () => {
    for (const component of ["text", "code", "log", "diff"] as const) {
      expect(checkUiData(component, { text: "hello" })).toEqual([]);
      expect(pathsOf(component, { text: 4 })).toEqual(["text"]);
    }
  });

  it("checks detail entries", () => {
    expect(checkUiData("detail", { entries: [{ label: "a", value: null }] })).toEqual([]);
    expect(pathsOf("detail", { entries: [{ label: "a" }] })).toEqual(["entries[0].value"]);
  });

  it("checks both chart branches and progress", () => {
    expect(checkUiData("chart", { series: [{ label: "cpu", points: [1, 2] }] })).toEqual([]);
    expect(checkUiData("chart", { value: 1, maximum: 4 })).toEqual([]);
    expect(pathsOf("chart", { series: [{ label: "cpu", points: ["x"] }] })).toEqual(["series[0].points[0]"]);
    expect(checkUiData("progress", { value: 1, maximum: 2 })).toEqual([]);
    expect(pathsOf("progress", { value: 1 })).toEqual(["maximum"]);
  });

  it("checks a badge and carries the tone fix", () => {
    expect(checkUiData("badge", { text: "ok", tone: "success" })).toEqual([]);
    const issues = checkUiData("badge", { text: "ok", tone: "pink" }) ?? [];
    expect(issues.map((issue) => issue.path)).toEqual(["tone"]);
    expect(issues[0]?.fix).toContain("neutral, accent, success, warning or danger");
  });

  it("reports a non-object answer at the root", () => {
    expect(pathsOf("list", "nope")).toEqual(["(root)"]);
  });

  it("answers null for a component that takes no data", () => {
    for (const component of ["button", "form", "field", "stack", "dialog"] as const) {
      expect(checkUiData(component, {})).toBeNull();
    }
  });
});
