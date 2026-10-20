import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sibling } from "../scripts/sibling.mjs";

function tree(): { outer: string; repo: string } {
  const outer = mkdtempSync(join(tmpdir(), "sibling-"));
  const repo = join(outer, "typescript");
  mkdirSync(repo);
  return { outer, repo };
}

function makeSibling(directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), "{}");
}

it("returns the inner path when both exist", () => {
  const { outer, repo } = tree();
  makeSibling(join(repo, "model"));
  makeSibling(join(outer, "model"));
  expect(sibling("model", repo)).toBe(join(repo, "model"));
});

it("returns the outer path when only the outer exists", () => {
  const { outer, repo } = tree();
  makeSibling(join(outer, "model"));
  expect(sibling("model", repo)).toBe(join(outer, "model"));
});

it("accepts a git checkout without a package.json", () => {
  const { repo } = tree();
  mkdirSync(join(repo, "model", ".git"), { recursive: true });
  expect(sibling("model", repo)).toBe(join(repo, "model"));
});

it("throws naming both paths when neither exists", () => {
  const { outer, repo } = tree();
  expect(() => sibling("model", repo)).toThrow(join(repo, "model"));
  expect(() => sibling("model", repo)).toThrow(join(outer, "model"));
});
