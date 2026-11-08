/**
 * Port of BuilderRegistry (Chatbot extension, System/GenerativeUI/BuilderRegistry.php).
 *
 * Port note: the PHP class reads JSON files from resources/builder/ on every call. This port takes
 * the same catalogue as an in-memory value, so it has no file or network access and tests can pass
 * a small fixture. Loading the real files is the caller's job.
 */
import { arrGet, isPlainObject, phpTruthy, readKey, type Obj } from "./semantics.ts";

export const BUILDER_COLLECTIONS = ["components", "blocks", "pages", "themes", "mock-data", "specs"] as const;
export type BuilderCollection = (typeof BUILDER_COLLECTIONS)[number];

export interface BuilderCatalogue {
  /** Contents of manifest.json. */
  manifest?: Obj;
  /**
   * Documents per collection, keyed by file slug (the PHP file name without ".json").
   * Only the collections listed in BUILDER_COLLECTIONS are read.
   */
  collections?: Partial<Record<BuilderCollection, Record<string, Obj>>>;
}

export class BuilderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderRegistryError";
  }
}

export interface BuilderRegistry {
  manifest(): Obj;
  all(collection: string): Obj[];
  find(collection: string, slug: string): Obj | null;
  mockData(slug: string): Obj;
  catalogue(): Obj;
  componentMap(): Record<string, Obj>;
  componentIds(): string[];
  actionIds(): string[];
  generativeUiCatalogue(): Obj;
  resolveSectionData(section: Obj, mockData: Obj): unknown;
}

function assertCollection(collection: string): asserts collection is BuilderCollection {
  if (!(BUILDER_COLLECTIONS as readonly string[]).includes(collection)) {
    throw new BuilderRegistryError(`Unsupported builder collection: ${collection}`);
  }
}

/** PHP-style comparison for the sort keys: plain string order. */
function compareText(a: unknown, b: unknown): number {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function createBuilderRegistry(catalogue: BuilderCatalogue): BuilderRegistry {
  const collections = catalogue.collections ?? {};

  const manifest = (): Obj => {
    if (!isPlainObject(catalogue.manifest)) {
      throw new BuilderRegistryError("Builder definition not found: manifest.json");
    }
    return catalogue.manifest;
  };

  const all = (collection: string): Obj[] => {
    assertCollection(collection);
    const documents = collections[collection] ?? {};
    return Object.values(documents)
      .filter(isPlainObject)
      .sort((a, b) => {
        const byCategory = compareText(a.category ?? "", b.category ?? "");
        if (byCategory !== 0) return byCategory;
        return compareText(a.name ?? a.id ?? "", b.name ?? b.id ?? "");
      });
  };

  const find = (collection: string, slug: string): Obj | null => {
    assertCollection(collection);
    // Same rule as the PHP: lower-case, strip anything outside [a-z0-9-], and refuse input that changed.
    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (safeSlug !== slug) return null;
    const documents = collections[collection] ?? {};
    return Object.prototype.hasOwnProperty.call(documents, safeSlug) ? documents[safeSlug] : null;
  };

  const componentIds = (): string[] => {
    const ids = all("components").map((component) => (typeof component.id === "string" ? component.id : null));
    // array_filter() without a callback drops falsy values, which includes "" and "0".
    return ids.filter((id): id is string => id !== null && id !== "" && id !== "0");
  };

  const actionIds = (): string[] => {
    const allowed = manifest().allowed_actions;
    if (!Array.isArray(allowed)) return [];
    return allowed.filter((action): action is string => typeof action === "string");
  };

  const componentMap = (): Record<string, Obj> => {
    const map: Record<string, Obj> = {};
    for (const component of all("components")) {
      if (typeof component.id === "string") {
        // keyBy() keeps the last document for a repeated id.
        Object.defineProperty(map, component.id, { value: component, enumerable: true, writable: true, configurable: true });
      }
    }
    return map;
  };

  const generativeUiCatalogue = (): Obj => ({
    version: "1.1",
    authority: "presentation-only",
    components: all("components"),
    actions: actionIds(),
    specs: all("specs"),
    surface_profiles: readKey(manifest(), "surface_profiles") ?? [],
  });

  return {
    manifest,
    all,
    find,
    mockData: (slug) => find("mock-data", slug) ?? {},
    catalogue: () => ({
      manifest: manifest(),
      components: all("components"),
      blocks: all("blocks"),
      pages: all("pages"),
      themes: all("themes"),
      specs: all("specs"),
      surface_profiles: readKey(manifest(), "surface_profiles") ?? [],
    }),
    componentMap,
    componentIds,
    actionIds,
    generativeUiCatalogue,
    resolveSectionData(section, mockData) {
      const source = readKey(section, "data_source");
      if (phpTruthy(source)) return arrGet(mockData, String(source), []);
      return readKey(section, "data") ?? [];
    },
  };
}
