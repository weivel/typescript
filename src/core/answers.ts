import type { Axis, PluginStatus, ReachKind, RefusalCode } from "./constants.js";
import {
  decodeStruct,
  readFixedElements,
  readGrowingElements,
  readHandles,
  readRefusal,
  readStrings,
  toBigInt,
  type DecodedList,
  type DecodedRefusal,
  type NativePointer,
} from "./memory.js";
import type { Refusal } from "./values.js";

export interface Support {
  readonly supported: boolean;
  readonly axis: Axis;
  readonly refusal: Refusal;
}

export interface ActivationEdge {
  readonly provider: bigint;
  readonly consumer: bigint;
}

export interface PluginRefusal {
  readonly plugin: bigint;
  readonly refusal: Refusal;
}

export interface ActivationPlan {
  readonly order: readonly bigint[];
  readonly edges: readonly ActivationEdge[];
  readonly cycles: readonly (readonly bigint[])[];
  readonly refusals: readonly PluginRefusal[];
}

export interface CapabilityImplementation {
  readonly implementation: bigint;
  readonly provider: bigint;
}

export interface LedgerRow {
  readonly plugin: bigint;
  readonly importName: string | null;
  readonly identity: string | null;
  readonly status: PluginStatus;
  readonly verified: boolean;
  readonly refusal: Refusal;
  readonly capabilitiesDeclared: readonly string[];
  readonly permissions: readonly string[];
  readonly servicesProvided: readonly string[];
  readonly capabilitiesProvided: readonly string[];
  readonly servicesConsumed: readonly string[];
  readonly capabilitiesConsumed: readonly string[];
}

export interface DeclarationRefusal {
  readonly reachKind: ReachKind;
  readonly plugin: bigint;
  readonly id: string | null;
  readonly code: RefusalCode;
  readonly subject: string | null;
  readonly hasFix: boolean;
}

export interface LedgerSnapshot {
  readonly rows: readonly LedgerRow[];
  readonly refusals: readonly DeclarationRefusal[];
}

export function readSupport(answer: object): Support {
  const support = decodeStruct(answer, 0, "weivel_support");
  return {
    supported: support.supported === 1,
    axis: support.axis as Axis,
    refusal: readRefusal(support.refusal as DecodedRefusal, support.subject, support.has_fix),
  };
}

function readPlanRefusals(plan: Record<string, unknown>): PluginRefusal[] {
  const count = plan.refusal_count as number;
  const subjects = readFixedElements(plan.refusal_subjects as NativePointer, count, "weivel_refusal_subject");
  return readFixedElements(plan.refusals as NativePointer, count, "weivel_plugin_refusal").map((element, index) => ({
    plugin: toBigInt(element.plugin),
    refusal: readRefusal(element.refusal as DecodedRefusal, subjects[index]?.subject, subjects[index]?.has_fix),
  }));
}

export function readActivationPlan(answer: object): ActivationPlan {
  const plan = decodeStruct(answer, 0, "weivel_activation_plan");
  return {
    order: readHandles(plan.order as NativePointer, plan.order_count as number),
    edges: readFixedElements(plan.edges as NativePointer, plan.edge_count as number, "weivel_edge").map((edge) => ({
      provider: toBigInt(edge.provider),
      consumer: toBigInt(edge.consumer),
    })),
    cycles: readFixedElements(plan.cycles as NativePointer, plan.cycle_count as number, "weivel_cycle").map((cycle) =>
      readHandles(cycle.members as NativePointer, cycle.count as number),
    ),
    refusals: readPlanRefusals(plan),
  };
}

export function readServiceList(answer: object): string[] {
  return readStrings(decodeStruct(answer, 0, "weivel_service_list").ids as DecodedList);
}

export function readCapabilityList(answer: object): CapabilityImplementation[] {
  const list = decodeStruct(answer, 0, "weivel_capability_list");
  return readGrowingElements(list.items as NativePointer, list.count as number, "weivel_capability_implementation").map(
    (element) => ({ implementation: toBigInt(element.implementation), provider: toBigInt(element.provider) }),
  );
}

function toLedgerRow(row: Record<string, unknown>): LedgerRow {
  return {
    plugin: toBigInt(row.plugin),
    importName: row.import_name as string | null,
    identity: row.identity as string | null,
    status: row.status as PluginStatus,
    verified: row.verified === 1,
    refusal: readRefusal(row.refusal as DecodedRefusal, row.subject, row.has_fix),
    capabilitiesDeclared: readStrings(row.capabilities_declared as DecodedList),
    permissions: readStrings(row.permissions as DecodedList),
    servicesProvided: readStrings(row.services_provided as DecodedList),
    capabilitiesProvided: readStrings(row.capabilities_provided as DecodedList),
    servicesConsumed: readStrings(row.services_consumed as DecodedList),
    capabilitiesConsumed: readStrings(row.capabilities_consumed as DecodedList | undefined),
  };
}

function toDeclarationRefusal(refusal: Record<string, unknown>): DeclarationRefusal {
  return {
    reachKind: refusal.kind as ReachKind,
    plugin: toBigInt(refusal.plugin),
    id: refusal.id as string | null,
    code: (refusal.code as RefusalCode | undefined) ?? 0,
    subject: (refusal.subject as string | null | undefined) ?? null,
    hasFix: refusal.has_fix === 1,
  };
}

export function readLedgerRow(answer: object): LedgerRow {
  return toLedgerRow(decodeStruct(answer, 0, "weivel_ledger_row"));
}

export function readLedgerSnapshot(answer: object): LedgerSnapshot {
  const snapshot = decodeStruct(answer, 0, "weivel_ledger_snapshot");
  return {
    rows: readGrowingElements(snapshot.rows as NativePointer, snapshot.row_count as number, "weivel_ledger_row").map(
      toLedgerRow,
    ),
    refusals: readGrowingElements(
      snapshot.refusals as NativePointer,
      snapshot.refusal_count as number,
      "weivel_declaration_refusal",
    ).map(toDeclarationRefusal),
  };
}
