import manifestJson from "./manifest.json" with { type: "json" };
import gettingStarted from "./getting-started.json" with { type: "json" };
import definingJobs from "./defining-jobs.json" with { type: "json" };
import emittingJobs from "./emitting-jobs.json" with { type: "json" };
import handlers from "./handlers.json" with { type: "json" };
import queues from "./queues.json" with { type: "json" };
import cronJobs from "./cron-jobs.json" with { type: "json" };
import management from "./management.json" with { type: "json" };
import gateway from "./gateway.json" with { type: "json" };
import broker from "./broker.json" with { type: "json" };
import storage from "./storage.json" with { type: "json" };
import configuration from "./configuration.json" with { type: "json" };

export type BlockType =
  | { type: "p"; text: string }
  | { type: "code"; lang: string; text: string; filename?: string }
  | { type: "h3"; text: string }
  | { type: "tip"; text: string }
  | { type: "warning"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

export interface DocSection {
  id: string;
  heading: string;
  blocks: BlockType[];
}

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  sections: DocSection[];
}

export interface ManifestItem {
  slug: string;
  title: string;
  description: string;
  order: number;
}

const DOC_REGISTRY: Record<string, DocPage> = {
  "getting-started": gettingStarted as unknown as DocPage,
  "defining-jobs": definingJobs as unknown as DocPage,
  "emitting-jobs": emittingJobs as unknown as DocPage,
  "handlers": handlers as unknown as DocPage,
  "queues": queues as unknown as DocPage,
  "cron-jobs": cronJobs as unknown as DocPage,
  "management": management as unknown as DocPage,
  "gateway": gateway as unknown as DocPage,
  "broker": broker as unknown as DocPage,
  "storage": storage as unknown as DocPage,
  "configuration": configuration as unknown as DocPage,
};

export function readManifest(): ManifestItem[] {
  return (manifestJson as ManifestItem[]).sort((a, b) => a.order - b.order);
}

export function readDoc(slug: string): DocPage | null {
  const safe = slug.replace(/[^a-z0-9-]/g, "");
  return DOC_REGISTRY[safe] ?? null;
}
