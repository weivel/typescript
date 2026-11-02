import type { ActionDeclaration, PluginManifest, ViewNode } from "../contract/model.js";
import type { ValidationIssue } from "./validation.js";

type Description = Pick<PluginManifest, "settings" | "actions" | "views" | "services">;

/**
 * Checks `VALIDATION.md` V3: every reference in a manifest's actions and views resolves.
 *
 * @remarks
 * Runs only on a manifest the schema accepted. An absent `settings`, `actions` or `services` is an
 * empty set, so a reference into it is refused rather than crashing.
 */
export function descriptionIssues(manifest: unknown): ValidationIssue[] {
  const description = manifest as Description;
  const providedServices = providedServiceIds(description);
  return [
    ...Object.entries(description.actions ?? {}).flatMap(([actionId, action]) =>
      actionIssues(actionId, action, providedServices),
    ),
    ...Object.entries(description.views ?? {}).flatMap(([viewId, view]) =>
      view.nodes.flatMap((node, index) => nodeIssues(description, providedServices, viewId, view.nodes, node, index)),
    ),
  ];
}

function actionIssues(actionId: string, action: ActionDeclaration, providedServices: ReadonlySet<string>): ValidationIssue[] {
  return unprovidedService(`actions.${actionId}.call.service`, action.call.service, providedServices);
}

function nodeIssues(
  description: Description,
  providedServices: ReadonlySet<string>,
  viewId: string,
  nodes: readonly ViewNode[],
  node: ViewNode,
  index: number,
): ValidationIssue[] {
  const base = `views.${viewId}.nodes[${index}]`;
  return [
    ...repeatedId(base, nodes, node, index),
    ...unresolvedParent(base, nodes, node, index),
    ...unresolvedName(`${base}.action`, node.action, description.actions, "actions"),
    ...unresolvedName(`${base}.field`, node.field, description.settings, "settings"),
    ...(node.bind === undefined ? [] : unprovidedService(`${base}.bind.service`, node.bind.service, providedServices)),
  ];
}

function repeatedId(base: string, nodes: readonly ViewNode[], node: ViewNode, index: number): ValidationIssue[] {
  if (!nodes.slice(0, index).some((earlier) => earlier.id === node.id)) {
    return [];
  }
  const path = `${base}.id`;
  return [{ path, message: `${path}: "${node.id}" is already the id of an earlier node in this view`, fix: "give each node in a view its own id" }];
}

function unresolvedParent(base: string, nodes: readonly ViewNode[], node: ViewNode, index: number): ValidationIssue[] {
  if (node.parent === undefined || nodes.slice(0, index).some((earlier) => earlier.id === node.parent)) {
    return [];
  }
  const path = `${base}.parent`;
  return [{ path, message: `${path}: "${node.parent}" is not the id of an earlier node in this view`, fix: "name the id of a node listed before this one" }];
}

function unresolvedName(
  path: string,
  name: string | undefined,
  declared: Record<string, unknown> | undefined,
  members: "actions" | "settings",
): ValidationIssue[] {
  if (name === undefined || Object.hasOwn(declared ?? {}, name)) {
    return [];
  }
  return [{ path, message: `${path}: "${name}" is not one of this manifest's ${members}`, fix: `name one of this manifest's ${members}` }];
}

function unprovidedService(path: string, service: string, providedServices: ReadonlySet<string>): ValidationIssue[] {
  if (providedServices.has(service)) {
    return [];
  }
  return [{ path, message: `${path}: "${service}" is not a service this plugin provides`, fix: "bind to a service this plugin provides" }];
}

function providedServiceIds(description: Description): Set<string> {
  const provided = description.services?.provides ?? [];
  return new Set(provided.map((entry) => (typeof entry === "string" ? entry : entry.id)));
}
