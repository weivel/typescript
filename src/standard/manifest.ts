import koffi from "koffi";
import type { Choice } from "../core/constants.js";
import { coreStructs } from "../core/declarations.js";
import { readGrowingElements, readNumbers, readStrings, type DecodedList } from "../core/memory.js";
import type { Manifest, ServiceOffer, ServiceWant } from "../core/values.js";

type DecodedFields = Record<string, unknown>;

interface DecodedDeclarations {
  provides: DecodedList;
  consumes: DecodedList;
}

function readOffer(offer: DecodedFields): ServiceOffer {
  return { id: offer.id as string, attributes: readNumbers(offer.attributes as DecodedList) };
}

function readWant(want: DecodedFields): ServiceWant {
  return {
    id: want.id as string,
    provider: (want.provider as string | null) ?? undefined,
    optional: want.optional as Choice,
    degradable: want.degradable as Choice,
    constraints: readNumbers(want.constraints as DecodedList),
  };
}

/**
 * Copies a weivel_manifest the standard answered into a value, so the standard's answer is never the thing a host
 * changes: an identity set on the copy leaves the view as the standard made it.
 */
export function copyManifestView(view: object): Manifest {
  const fields = koffi.decode(view, coreStructs.weivel_manifest) as DecodedFields;
  const capabilities = fields.capabilities as DecodedDeclarations;
  const services = fields.services as DecodedDeclarations;
  return {
    importName: fields.import_name as string,
    api: fields.api as number,
    entry: (fields.entry as string | null) ?? undefined,
    targets: readStrings(fields.targets as DecodedList),
    capabilities: { provides: readStrings(capabilities.provides), consumes: readStrings(capabilities.consumes) },
    services: {
      provides: readGrowingElements(services.provides.items, services.provides.count, "weivel_service_offer").map(readOffer),
      consumes: readGrowingElements(services.consumes.items, services.consumes.count, "weivel_service_want").map(readWant),
    },
    permissions: readStrings(fields.permissions as DecodedList),
    identity: (fields.identity as string | null) ?? undefined,
  };
}
