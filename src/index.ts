import Koa from "koa";
import { Event, Filter, Kind, nip19 } from "nostr-tools";
import { ensureConnected, getRelay } from "./relays.js";

const DEFAULT_PAGE =
  "ec79a4691d70c3587ce378dbe28c10eb1e926904a903dce97d3d76d887f9b9b6";
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nostr-pub.wellorder.net",
  "wss://e.nos.lol",
];

const isHex = /[0-9a-f]{58}/i;
enum PageKinds {
  Root = 30051,
  Page = 10051,
  ChunkedPage = 10052,
}

const app = new Koa({
  subdomainOffset: process.env.NODE_ENV === "development" ? 1 : 2,
});

async function queryRelays(
  filter: Filter,
  relays: string[] = DEFAULT_RELAYS
): Promise<Event<Kind>> {
  const events = await Promise.all(
    relays.map(async (url) => {
      const relay = getRelay(url);
      await ensureConnected(relay);
      return await relay.get(filter);
    })
  );

  return events.filter(Boolean).sort((a, b) => a.created_at - b.created_at)[0];
}

const cache = new Map<string, Event<Kind>>();
async function getEventById(id: string, relays: string[]) {
  if (cache.has(id)) return cache.get(id)!;
  const event = await queryRelays({ ids: [id] }, relays);
  if (event) cache.set(event.id, event);
  return event;
}

async function resolveEvent(
  pointer: string
): Promise<Event<number> | undefined> {
  let relays = getRelaysForPointer(pointer);

  if (pointer.match(isHex)) {
    return await queryRelays({ ids: [pointer] }, relays);
  }

  const decoded = nip19.decode(pointer);

  let event: Event;
  switch (decoded.type) {
    case "nevent":
      event = await queryRelays({ ids: [decoded.data.id] }, relays);
      return event;
    case "naddr":
      event = await queryRelays(
        {
          authors: [decoded.data.pubkey],
          "#d": [decoded.data.identifier],
          kinds: [decoded.data.kind],
        },
        relays
      );
      return event;
  }
}

function getRelaysForPointer(pointer: string) {
  if (pointer.match(isHex)) return DEFAULT_RELAYS;

  const decoded = nip19.decode(pointer);

  switch (decoded.type) {
    case "nevent":
    case "naddr":
    case "nprofile":
      return decoded.data.relays.length === 0
        ? DEFAULT_RELAYS
        : decoded.data.relays;
  }
}

function respondWithEvent(ctx: Koa.Context, event: Event) {
  ctx.response.header["x-nostr-event"] = event.id;
  ctx.response.header["x-nsotr-pubkey"] = event.pubkey;

  try {
    // try to parse base64 blob
    const blob = Uint8Array.from(atob(event.content), (c) => c.charCodeAt(0));
    ctx.response.body = Buffer.from(blob);
  } catch (e) {
    ctx.response.body = event.content;
  }

  for (const tag of event.tags) {
    if (tag[0] === "header" && tag.length === 3) {
      ctx.response.set(tag[1], tag[2]);
    }
  }
}

const rootEventCache = new Map<string, Event>();
app.use(async (ctx) => {
  try {
    const pointer = ctx.subdomains[0] || DEFAULT_PAGE;
    const relays = getRelaysForPointer(pointer);
    const event = rootEventCache.get(pointer) || (await resolveEvent(pointer));
    if (!event) return (ctx.state = 404);
    rootEventCache.set(pointer, event);

    // redirect to another app if its not a root page
    if (event.kind !== PageKinds.Root) {
      ctx.redirect(
        `https://nostrapp.link/#${nip19.neventEncode({
          id: event.id,
          relays,
        })}`
      );
      return;
    }

    const tag = event.tags.find((t) => t[0] === "e" && t[3] === ctx.path);
    if (tag) {
      const subEvent = await getEventById(tag[1], relays);
      if (!subEvent) return (ctx.status = 404);

      respondWithEvent(ctx, subEvent);
      return;
    } else if (ctx.path === "/") {
      respondWithEvent(ctx, event);
      return;
    } else {
      ctx.status = 404;
      ctx.body = `${ctx.path} dose not exist on ${event.id}`;
      return;
    }
  } catch (e) {
    ctx.status = 500;
    if (e instanceof Error) {
      ctx.body = e.stack;
    }
  }
});

app.listen(3000);

console.log(`Server listening on port 3000`);

async function shutdown() {
  process.exit();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.once("SIGUSR2", shutdown);
